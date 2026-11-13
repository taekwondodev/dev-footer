// Transcript rows for dev's workspace messages, drawn from `details` only, never from
// model-visible content: `/workspace` answers and sweep receipts (`dev/workspace`), receipts
// that changed nothing (`dev/workspace-receipt` entries), admissions refused for review
// (`dev/workspace-refusal` entries) and switches (`dev/workspace-handoff`).
// A workspace is named by its short id, and a managed worktree by `worktree <id>` instead of
// its long path; ctrl+o adds reasons, next actions and the rows a collapsed sweep leaves out.
import { homedir } from 'node:os'
import type { EntryRenderer, MessageRenderer, Theme, ThemeColor } from '@earendil-works/pi-coding-agent'
import { Box, type Component, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { oneLine, plainDeep } from './header.ts'

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const objects = (value: unknown): Fields[] => (Array.isArray(value) ? value.filter(isObject) : [])
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []

const EXPAND = 'app.tools.expand'

interface Hints {
  readonly keyText: (binding: typeof EXPAND) => string
}

const HOME = homedir()
const shortId = (id: unknown): string => (typeof id === 'string' ? id.slice(0, 8) : '')
const shortPath = (path: string): string => (path === HOME || path.startsWith(`${HOME}/`) ? `~${path.slice(HOME.length)}` : path)

const place = (theme: Theme, fields: Fields): string => {
  const id = shortId(fields.workspaceId)
  const path = text(fields.path)
  if (fields.origin === 'managed' || path === undefined) return `${theme.fg('text', 'worktree')} ${theme.fg('muted', id)}`
  return `${theme.fg('text', shortPath(path))} ${theme.fg('dim', id)}`
}

const task = (theme: Theme, taskId: unknown): string =>
  typeof taskId === 'string' ? theme.fg('dim', `task ${shortId(taskId)}`) : theme.fg('dim', 'no task')

// The status is a colored word in a fixed column: no glyph repeats it, so every row starts
// with text the font draws at its own width, and the columns after it line up.
const STATUS_WIDTH = 9
const status = (theme: Theme, color: ThemeColor, word: string): string => theme.fg(color, word.padEnd(STATUS_WIDTH))

const SWEEP_STATUS: Record<string, readonly [ThemeColor, string]> = {
  removed: ['success', 'removed'],
  released: ['success', 'released'],
  'review-required': ['error', 'review'],
  retained: ['dim', 'kept'],
  skipped: ['dim', 'skipped'],
  deferred: ['dim', 'deferred'],
}

const VIEW_STATUS: Record<string, readonly [ThemeColor, string]> = {
  active: ['accent', 'active'],
  'preserved-for-resume': ['muted', 'resumable'],
  blocked: ['warning', 'blocked'],
  'review-required': ['error', 'review'],
  released: ['dim', 'released'],
  removed: ['dim', 'removed'],
}

const statusOf = (theme: Theme, table: typeof SWEEP_STATUS, outcome: unknown): string => {
  const [color, word] = table[String(outcome)] ?? ['dim', String(outcome)]
  return status(theme, color, word)
}

// A row is a status, a place and a trailing fact; details sit under the place column.
interface Row {
  readonly status: string
  readonly place: string
  readonly trail: string
  readonly details: readonly string[]
}

const GAP = '  '
const INDENT = '  '
const DETAIL = INDENT + ' '.repeat(STATUS_WIDTH) + GAP

const detail = (theme: Theme, line: string, color: ThemeColor = 'dim'): string => `${DETAIL}${theme.fg(color, line)}`

// Places differ in width (a path or `worktree <id>`), so each block pads them to its widest.
function table(rows: readonly Row[]): string[] {
  const width = Math.max(0, ...rows.map(row => visibleWidth(row.place)))
  return rows.flatMap(row => {
    const place = row.trail === '' ? row.place : row.place + ' '.repeat(width - visibleWidth(row.place))
    const cells = [row.status, place, ...(row.trail === '' ? [] : [row.trail])]
    return [`${INDENT}${cells.join(GAP)}`.trimEnd(), ...row.details]
  })
}

const MOMENTS: Record<string, string> = {
  allocation: 'before an allocation',
  replacement: 'at a conversation replacement',
  quit: 'at quit',
}

interface SweepRow extends Row {
  readonly outcome: string
  readonly changed: boolean
  readonly reason?: string
}

function sweepRow(theme: Theme, row: Fields): SweepRow {
  const base = (outcome: string, changed: boolean, place: string, reason: string | undefined): SweepRow => ({
    outcome,
    changed,
    status: statusOf(theme, SWEEP_STATUS, outcome),
    place,
    trail: task(theme, row.taskId),
    details: [],
    ...(reason === undefined ? {} : { reason }),
  })
  switch (row.kind) {
    case 'workspace': {
      const outcome = String(row.outcome)
      const verdict = isObject(row.verdict) ? text(row.verdict.reason) : undefined
      const reason = outcome === 'review-required' ? text(row.reason) : verdict
      return base(outcome, outcome !== 'retained' && outcome !== 'skipped', place(theme, row), reason)
    }
    case 'task-artifacts': {
      const outcome = String(row.outcome)
      return base(outcome, true, theme.fg('text', 'artifacts'), outcome === 'review-required' ? text(row.reason) : undefined)
    }
    case 'task-deferred':
      return base('deferred', false, '', undefined)
    case 'task-failure':
      return base('review-required', true, '', text(row.reason))
    default:
      return { ...base('review-required', true, theme.fg('text', 'sweep'), text(row.reason)), trail: '' }
  }
}

const SWEEP_ORDER = Object.keys(SWEEP_STATUS)

const counts = (rows: readonly SweepRow[]): string => {
  const byOutcome = new Map<string, number>()
  for (const row of rows) byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1)
  return [...byOutcome]
    .toSorted(([left], [right]) => SWEEP_ORDER.indexOf(left) - SWEEP_ORDER.indexOf(right))
    .map(([outcome, count]) => `${count} ${SWEEP_STATUS[outcome]?.[1] ?? outcome}`)
    .join(' · ')
}

// A header's hint sits at the right edge, as in the work rows; the summary is cut before it.
interface Header {
  readonly left: string
  readonly hint: string
}
type Line = string | Header

const header = (theme: Theme, title: string, rest: string, hint: string): Header => ({
  left: `${theme.bold(theme.fg('toolTitle', title))}  ${rest}`,
  hint: hint === '' ? '' : theme.fg('dim', hint),
})

function headerLine({ left, hint }: Header, width: number): string {
  if (hint === '') return left
  const summary = truncateToWidth(left, Math.max(1, width - visibleWidth(hint) - 3), '…')
  return truncateToWidth(summary + ' '.repeat(Math.max(3, width - visibleWidth(summary) - visibleWidth(hint))) + hint, width, '…')
}

const hintOf = (expanded: boolean, hints: Hints): string => (expanded ? '' : `${hints.keyText(EXPAND)} per i dettagli`)

// The header counts every outcome, so collapsed rows leave out kept and skipped ones silently.
function sweepLines(theme: Theme, receipt: Fields, expanded: boolean, hints: Hints): Line[] {
  const all = objects(receipt.rows).map(row => sweepRow(theme, row))
  if (all.length === 0) return []
  const shown = (expanded ? all : all.filter(row => row.changed)).map(row => ({
    ...row,
    details:
      row.reason !== undefined && (expanded || row.outcome === 'review-required')
        ? [detail(theme, oneLine(row.reason), row.outcome === 'review-required' ? 'error' : 'dim')]
        : [],
  }))
  const moment = MOMENTS[String(receipt.moment)]
  const summary = [...(moment === undefined ? [] : [moment]), counts(all)].join(' · ')
  const hint = shown.length < all.length || all.some(row => row.reason !== undefined) ? hintOf(expanded, hints) : ''
  return [header(theme, 'workspace sweep', theme.fg('muted', summary), hint), ...table(shown)]
}

function viewRow(theme: Theme, view: Fields, expanded: boolean, current: unknown): Row {
  const here = current !== undefined && view.workspaceId === current ? `${GAP}${theme.fg('accent', 'current')}` : ''
  const details: string[] = []
  if (expanded) {
    if (view.origin === 'managed' && text(view.path) !== undefined) details.push(detail(theme, shortPath(text(view.path)!)))
    if (text(view.reason) !== undefined) details.push(detail(theme, oneLine(text(view.reason)!)))
    if (text(view.nextAction) !== undefined) details.push(detail(theme, `next: ${oneLine(text(view.nextAction)!)}`))
    for (const use of objects(view.uses)) {
      const attempt = isObject(use.execution) ? text(use.execution.attemptId) : undefined
      details.push(detail(theme, `use ${String(use.access)} · ${String(use.stage)}${attempt === undefined ? '' : ` · attempt ${shortId(attempt)}`}`))
    }
    for (const item of objects(view.pending)) details.push(detail(theme, `pending ${String(item.kind)} · ${String(item.stage)}`, 'warning'))
  }
  return { status: statusOf(theme, VIEW_STATUS, view.outcome), place: place(theme, view), trail: task(theme, view.taskId) + here, details }
}

const emptyRow = (theme: Theme): string => `${INDENT}${theme.fg('dim', 'no workspace records')}`

function reportLines(theme: Theme, report: Fields, expanded: boolean, hints: Hints): Line[] {
  const hint = hintOf(expanded, hints)
  const artifacts = text(report.artifacts)
  const artifactsLine =
    expanded && artifacts !== undefined ? [`${INDENT}${status(theme, 'dim', 'artifacts')}${GAP}${theme.fg('dim', shortPath(artifacts))}`] : []
  if (report.kind === 'list') {
    const views = objects(report.views)
    const root = text(report.repositoryRoot)
    const current = isObject(report.current) ? report.current.workspaceId : undefined
    const summary = [...(root === undefined ? [] : [shortPath(root)]), `${views.length} ${views.length === 1 ? 'workspace' : 'workspaces'}`]
    return [
      header(theme, 'workspace', theme.fg('muted', summary.join(' · ')), hint),
      ...table(views.map(view => viewRow(theme, view, expanded, current))),
      ...artifactsLine,
    ]
  }
  if (report.kind === 'inspect') {
    const views = objects(report.views)
    return [
      header(theme, 'workspace inspect', task(theme, report.taskId), hint),
      ...(views.length === 0 ? [emptyRow(theme)] : table(views.map(view => viewRow(theme, view, expanded, undefined)))),
      ...artifactsLine,
    ]
  }
  if (report.kind === 'check') {
    const assessments = objects(report.assessments)
    const rows = assessments.map((assessment): Row => {
      const completion = isObject(assessment.completion) ? assessment.completion : {}
      const finished = completion.kind === 'finished'
      const details: string[] = []
      if (expanded) {
        if (text(completion.reason) !== undefined) details.push(detail(theme, oneLine(text(completion.reason)!)))
        for (const reason of strings(assessment.reasons)) details.push(detail(theme, `- ${oneLine(reason)}`))
        const target = isObject(assessment.target) ? text(assessment.target.description) : undefined
        if (target !== undefined) details.push(detail(theme, `target: ${oneLine(target)}`))
        for (const item of strings(assessment.residual)) details.push(detail(theme, `residual: ${oneLine(item)}`, 'warning'))
        for (const action of strings(assessment.nextActions)) details.push(detail(theme, `next: ${oneLine(action)}`))
      }
      return {
        status: status(theme, finished ? 'success' : 'muted', finished ? 'finished' : 'retained'),
        place: place(theme, assessment),
        trail: theme.fg('dim', String(finished ? completion.rule : completion.retained)),
        details,
      }
    })
    return [
      header(theme, 'workspace check', `${task(theme, report.taskId)}${GAP}${theme.fg('dim', 'changes nothing')}`, hint),
      ...(rows.length === 0 ? [emptyRow(theme)] : table(rows)),
    ]
  }
  return []
}

// Lines are rebuilt only when the width changes; render() reads memory only. Collapsed rows
// are cut at the edge; expanded ones wrap, so ctrl+o shows every reason and command whole.
class Rows implements Component {
  private cache: { readonly width: number; readonly lines: string[] } | undefined

  constructor(
    private readonly lines: readonly Line[],
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines
    const box = new Box(1, 1, line => this.theme.bg('customMessageBg', line))
    const inner = Math.max(1, width - 2)
    const shown = this.lines.map(line => {
      if (typeof line !== 'string') return headerLine(line, inner)
      return this.expanded ? line : truncateToWidth(line, inner, '…')
    })
    box.addChild(new Text(shown.join('\n'), 0, 0))
    const lines = box.render(width)
    this.cache = { width, lines }
    return lines
  }

  invalidate(): void {
    this.cache = undefined
  }
}

const rows = (lines: readonly Line[], expanded: boolean, theme: Theme): Component | undefined =>
  lines.length === 0 ? undefined : new Rows(lines, expanded, theme)

// Workspace facts are drawn on single rows: a path or reason with a newline or tab must not
// open a row of its own.
const facts = (value: unknown): unknown => plainDeep(value, oneLine)

export const workspaceMessageRenderer: MessageRenderer = (message, options, theme) => {
  const details = facts(message.details)
  if (!isObject(details)) return undefined
  if (details.kind === 'sweep' && isObject(details.receipt))
    return rows(sweepLines(theme, details.receipt, options.expanded, options), options.expanded, theme)
  return rows(reportLines(theme, details, options.expanded, options), options.expanded, theme)
}

export const receiptEntryRenderer: EntryRenderer = (entry, options, theme) => {
  const data = facts(entry.data)
  if (!isObject(data) || data.kind !== 'sweep' || !isObject(data.receipt)) return undefined
  return rows(sweepLines(theme, data.receipt, options.expanded, options), options.expanded, theme)
}

// A refusal that ended the turn has no answer from the model: the reason and the next step
// are always shown, cut at the edge until ctrl+o wraps them.
function refusalLines(theme: Theme, refusal: Fields, expanded: boolean, hints: Hints): Line[] {
  const reason = text(refusal.reason)
  if (reason === undefined) return []
  const effect = refusal.endedTurn === true ? 'turn ended' : 'command not run'
  const next = text(refusal.next)
  return [
    header(theme, 'workspace refusal', theme.fg('muted', `review required · ${effect}`), hintOf(expanded, hints)),
    `${INDENT}${theme.fg('error', oneLine(reason))}`,
    ...(next === undefined ? [] : [`${INDENT}${theme.fg('dim', `next: ${oneLine(next)}`)}`]),
  ]
}

export const refusalEntryRenderer: EntryRenderer = (entry, options, theme) => {
  const data = facts(entry.data)
  if (!isObject(data) || data.kind !== 'refusal') return undefined
  return rows(refusalLines(theme, data, options.expanded, options), options.expanded, theme)
}

// A switch is one row; ctrl+o shows the full handoff the model received.
export const handoffRenderer: MessageRenderer = (message, options, theme) => {
  const details = facts(message.details)
  if (!isObject(details) || details.kind !== 'switch') return undefined
  const cwd = text(details.cwd)
  const reason = text(details.reason)
  const lines: Line[] = [
    header(
      theme,
      details.resumed === true ? 'workspace resumed' : 'workspace switched',
      `${theme.fg('muted', shortId(details.workspaceId))}${cwd === undefined ? '' : `${GAP}${theme.fg('dim', shortPath(cwd))}`}`,
      hintOf(options.expanded, options),
    ),
    ...(reason === undefined ? [] : [`${INDENT}${theme.fg('muted', oneLine(reason))}`]),
  ]
  if (options.expanded && typeof message.content === 'string')
    lines.push('', ...String(plainDeep(message.content)).split('\n').map(line => theme.fg('dim', `${INDENT}${line}`)))
  return rows(lines, options.expanded, theme)
}
