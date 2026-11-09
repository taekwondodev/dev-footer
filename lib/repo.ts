import { execFile } from 'node:child_process'
import { access, open, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export interface Diff {
  readonly added: number
  readonly removed: number
}

export interface RepoFacts {
  readonly url?: string
  readonly defaultBranch?: string
  readonly worktrees: number
  readonly diff?: Diff
}

export type PullRequestState = 'open' | 'draft' | 'merged' | 'closed'

export interface PullRequest {
  readonly number: number
  readonly url: string
  readonly state: PullRequestState
}

const NO_REPO: RepoFacts = { worktrees: 0 }
// Untracked files are counted by reading them; these bounds keep a stray
// unignored build directory from turning a refresh into a full scan.
const UNTRACKED_FILES = 500
const UNTRACKED_BYTES = 1024 * 1024
// Git's binary heuristic: a NUL byte within the first 8000 bytes.
const BINARY_PROBE = 8000
const TIMEOUT_MS = 10_000

interface Checkout {
  readonly root: string
  readonly common: string
}

async function checkout(cwd: string): Promise<Checkout | undefined> {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git')
    const info = await stat(dotGit).catch(() => undefined)
    if (info?.isDirectory()) return { root: dir, common: dotGit }
    if (info?.isFile()) {
      const pointer = /^gitdir:\s*(.+)$/m.exec(await readFile(dotGit, 'utf8'))?.[1]?.trim()
      if (pointer === undefined) return undefined
      const gitDir = resolve(dir, pointer)
      const common = await readFile(join(gitDir, 'commondir'), 'utf8').then(
        common => resolve(gitDir, common.trim()),
        () => gitDir,
      )
      return { root: dir, common }
    }
    if (dirname(dir) === dir) return undefined
  }
}

export function githubUrl(config: string): string | undefined {
  const origin = /\[remote "origin"\]([^[]*)/.exec(config)?.[1]
  const url = origin === undefined ? undefined : /^\s*url\s*=\s*(\S+)/m.exec(origin)?.[1]
  const match =
    url === undefined
      ? undefined
      : /^(?:git@github\.com:|ssh:\/\/git@github\.com\/|https:\/\/(?:[^@/]+@)?github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url)
  return match === null || match === undefined ? undefined : `https://github.com/${match[1]}/${match[2]}`
}

// A linked worktree counts while the checkout its admin entry points to still exists.
async function linkedWorktrees(common: string): Promise<number> {
  const admin = join(common, 'worktrees')
  const names = await readdir(admin).catch(() => [])
  const alive = await Promise.all(
    names.map(name =>
      readFile(join(admin, name, 'gitdir'), 'utf8').then(
        path => access(path.trim()).then(() => true, () => false),
        () => false,
      ),
    ),
  )
  return alive.filter(Boolean).length
}

async function defaultBranch(common: string): Promise<string | undefined> {
  const head = await readFile(join(common, 'refs/remotes/origin/HEAD'), 'utf8').catch(() => '')
  return /^ref: refs\/remotes\/origin\/(.+)$/m.exec(head)?.[1]?.trim()
}

// --no-optional-locks keeps git from refreshing the index, so the footer writes nothing.
const git = (root: string, ...args: string[]): Promise<string> =>
  run('git', ['--no-optional-locks', ...args], { cwd: root, timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }).then(
    result => result.stdout,
  )

export function shortstat(text: string): Diff {
  return {
    added: Number(/(\d+) insertions?\(\+\)/.exec(text)?.[1] ?? 0),
    removed: Number(/(\d+) deletions?\(-\)/.exec(text)?.[1] ?? 0),
  }
}

// Counts lines like git does for an added file; binary and oversized files count as zero.
async function fileLines(path: string): Promise<number> {
  const file = await open(path, 'r').catch(() => undefined)
  if (file === undefined) return 0
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size === 0 || info.size > UNTRACKED_BYTES) return 0
    const content = await file.readFile()
    if (content.subarray(0, BINARY_PROBE).includes(0)) return 0
    let lines = 0
    for (let index = content.indexOf(10); index !== -1; index = content.indexOf(10, index + 1)) lines++
    return content[content.length - 1] === 10 ? lines : lines + 1
  } finally {
    await file.close()
  }
}

// Tracked changes against HEAD, staged or not, plus the lines of untracked files.
async function readDiff(root: string): Promise<Diff | undefined> {
  try {
    const [tracked, untracked] = await Promise.all([
      git(root, 'diff', 'HEAD', '--shortstat'),
      git(root, 'ls-files', '--others', '--exclude-standard', '-z'),
    ])
    const names = untracked.split('\0').filter(Boolean).slice(0, UNTRACKED_FILES)
    const added = await Promise.all(names.map(name => fileLines(join(root, name))))
    const diff = shortstat(tracked)
    return { added: diff.added + added.reduce((sum, lines) => sum + lines, 0), removed: diff.removed }
  } catch {
    return undefined
  }
}

export async function readRepoFacts(cwd: string): Promise<RepoFacts> {
  const found = await checkout(cwd).catch(() => undefined)
  if (found === undefined) return NO_REPO
  const { root, common } = found
  const [config, worktrees, branch, diff] = await Promise.all([
    readFile(join(common, 'config'), 'utf8').catch(() => ''),
    linkedWorktrees(common),
    defaultBranch(common),
    readDiff(root),
  ])
  const url = githubUrl(config)
  return {
    ...(url === undefined ? {} : { url }),
    ...(branch === undefined ? {} : { defaultBranch: branch }),
    worktrees,
    ...(diff === undefined ? {} : { diff }),
  }
}

export function pullRequestState(state: string, isDraft: boolean): PullRequestState {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return isDraft ? 'draft' : 'open'
}

// The latest pull request whose head is `branch`, through gh's own credentials.
export async function readPullRequest(cwd: string, branch: string): Promise<PullRequest | undefined> {
  try {
    const { stdout } = await run('gh', ['pr', 'view', branch, '--json', 'number,url,state,isDraft'], {
      cwd,
      timeout: TIMEOUT_MS,
      env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1' },
    })
    const view = JSON.parse(stdout) as { number: number; url: string; state: string; isDraft: boolean }
    return { number: view.number, url: view.url, state: pullRequestState(view.state, view.isDraft) }
  } catch {
    return undefined
  }
}
