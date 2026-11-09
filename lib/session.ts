// Reads a child's session file once, asynchronously and under a size cap, for the
// ctrl+o trail and the full answer. Renderers only look up the cache; a finished read
// asks for one redraw.
import { open } from 'node:fs/promises'
import { homedir } from 'node:os'
import { plain } from './header.ts'

export const SESSION_LIMIT_BYTES = 8 * 1024 * 1024
const CACHED_SESSIONS = 64

export type SessionRead =
  | { readonly state: 'loading' }
  | { readonly state: 'missing' }
  | { readonly state: 'oversized'; readonly bytes: number }
  | { readonly state: 'ready'; readonly trail: readonly (readonly string[])[]; readonly answer?: string }

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)

export const shortPath = (path: string, cwd: string | undefined, home = homedir()): string => {
  if (cwd !== undefined && path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1)
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

// The same redaction as dev's live activity: secret-like values, and URL path segments of
// 20 or more characters that mix letters and digits, such as bot or webhook tokens.
const isOpaqueSegment = (segment: string): boolean =>
  segment.length >= 20 && /\d/.test(segment) && /[A-Za-z]/.test(segment)

const redactSecrets = (text: string): string =>
  text
    .replace(/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')

const publicUrl = (value: string): string | undefined => {
  if (!URL.canParse(value)) return undefined
  const url = new URL(value)
  const path = url.pathname
    .split('/')
    .map(segment => (isOpaqueSegment(segment) ? '[redacted]' : segment))
    .join('/')
  return `${url.protocol}//${url.host}${path}`
}

export const TARGET_LIMIT = 120
const capped = (text: string): string => [...text].slice(0, TARGET_LIMIT).join('')

// The same allowlist as dev's live activity: no command or script text.
export const trailItem = (name: string, args: unknown, cwd: string | undefined): string => {
  const field = (key: string) => (isObject(args) ? text(args[key]) : undefined)
  const path = field('path') === undefined ? undefined : shortPath(field('path')!, cwd)
  const url = field('url')
  let target: string | undefined
  if (['read', 'ls', 'edit', 'write'].includes(name)) target = path
  else if (['grep', 'find'].includes(name)) target = field('pattern') ?? path
  else if (name === 'git_inspect') target = [field('operation'), path].filter(Boolean).join(' ') || undefined
  else if (name === 'read_url' && url !== undefined) target = publicUrl(url)
  return plain(target === undefined ? name : `${name} ${capped(redactSecrets(target).replace(/\s+/g, ' '))}`)
}

export function parseSession(content: string): Extract<SessionRead, { state: 'ready' }> {
  let cwd: string | undefined
  const nested = new Map<string, readonly string[]>()
  const turns: { readonly calls: readonly { readonly id: string; readonly name: string; readonly args: unknown }[] }[] = []
  let answer: string | undefined
  for (const line of content.split('\n')) {
    if (line === '') continue
    let entry: unknown
    try {
      entry = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(entry)) continue
    if (entry.type === 'session') cwd = text(entry.cwd)
    if (entry.type !== 'message' || !isObject(entry.message)) continue
    const message = entry.message
    if (message.role === 'toolResult' && isObject(message.nestedCalls) && Array.isArray(message.nestedCalls.calls)) {
      const id = text(message.toolCallId)
      if (id !== undefined)
        nested.set(
          id,
          message.nestedCalls.calls.flatMap(call =>
            isObject(call) && text(call.name) !== undefined ? [trailItem(call.name as string, call.arguments, cwd)] : [],
          ),
        )
    }
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue
    const calls = message.content.flatMap(part =>
      isObject(part) && part.type === 'toolCall' && text(part.name) !== undefined
        ? [{ id: text(part.id) ?? '', name: part.name as string, args: part.arguments }]
        : [],
    )
    if (calls.length > 0) turns.push({ calls })
    const reply = message.content
      .flatMap(part => (isObject(part) && part.type === 'text' && typeof part.text === 'string' ? [part.text] : []))
      .join('')
      .trim()
    if (reply !== '') answer = plain(reply)
  }
  const trail = turns.map(({ calls }) =>
    calls.flatMap(call => {
      const inner = nested.get(call.id)
      return inner !== undefined && inner.length > 0 ? inner : [trailItem(call.name, call.args, cwd)]
    }),
  )
  return { state: 'ready', trail, ...(answer === undefined ? {} : { answer }) }
}

async function load(path: string): Promise<SessionRead> {
  const file = await open(path, 'r').catch(() => undefined)
  if (file === undefined) return { state: 'missing' }
  try {
    const info = await file.stat()
    if (!info.isFile()) return { state: 'missing' }
    if (info.size > SESSION_LIMIT_BYTES) return { state: 'oversized', bytes: info.size }
    return parseSession(await file.readFile('utf8'))
  } catch {
    return { state: 'missing' }
  } finally {
    await file.close().catch(() => undefined)
  }
}

const cache = new Map<string, SessionRead>()
const listeners = new Set<() => void>()

export const onSessionRead = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Starts the read on first request and returns what is known now.
export function sessionRead(path: string): SessionRead {
  const known = cache.get(path)
  if (known !== undefined) return known
  const loading: SessionRead = { state: 'loading' }
  cache.set(path, loading)
  while (cache.size > CACHED_SESSIONS) cache.delete(cache.keys().next().value!)
  void load(path).then(result => {
    if (cache.get(path) !== loading) return
    cache.set(path, result)
    for (const listener of listeners) listener()
  })
  return loading
}

export const cachedSession = (path: string): SessionRead | undefined => cache.get(path)
