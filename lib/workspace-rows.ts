// Transcript rows for dev's workspace messages, drawn from `details` only, never from
// model-visible content: `/workspace` answers and sweep receipts (`dev/workspace`), receipts
// that changed nothing (`dev/workspace-receipt` entries), admissions refused for review
// (`dev/workspace-refusal` entries) and switches (`dev/workspace-handoff`).
// A workspace is named by its short id, and a managed worktree by `worktree <id>` instead of
// its long path; ctrl+o adds reasons, next actions and the rows a collapsed sweep leaves out.
import { homedir } from 'node:os'
import type { EntryRenderer, MessageRenderer, Theme, ThemeColor } from '@earendil-works/pi-coding-agent'
import { Box, type Component, Text, truncateToWidth } from '@earendil-works/pi-tui'
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

const mark = (theme: Theme, color: ThemeColor, glyph: string, word: string, width: number): string =>
  `${theme.fg(color, glyph)} ${theme.fg(color === 'dim' ? 'dim' : 'text', word.padEnd(width))}`

const SWEEP_MARKS: Record<string, readonly [ThemeColor, string, string]> = {
  removed: ['success', '✓', 'removed'],
  released: ['success', '✓', 'released'],
  'review-required': ['error', '✗', 'review'],
  retained: ['dim', '◌', 'kept'],
  skipped: ['dim', '⊘', 'skipped'],
  deferred: ['dim', '◌', 'deferred'],
}

const VIEW_MARKS: Record<string, readonly [ThemeColor, string, string]> = {
  active: ['accent', '●', 'active'],
  'preserved-for-resume': ['dim', '◌', 'resumable'],
  blocked: ['warning', '!', 'blocked'],
  'review-required': ['error', '✗', 'review'],
  released: ['dim', '✓', 'released'],
  removed: ['dim', '✓', 'removed'],
}

const markOf = (theme: Theme, marks: typeof SWEEP_MARKS, outcome: unknown): string => {
  const [color, glyph, word] = marks[String(outcome)] ?? ['dim', '?', String(outcome)]
  return mark(theme, color, glyph, word, 10)
}

const detail = (theme: Theme, line: string, color: ThemeColor = 'dim'): string => `      ${theme.fg(color, line)}`

const MOMENTS: Record<string, string> = {
  allocation: 'before an allocation',
  replacement: 'at a conversation replacement',
  quit: 'at quit',
}

interface SweepRow {
  readonly outcome: string
  readonly changed: boolean
  readonly line: string
  readonly reason?: string
}

function sweepRow(theme: Theme, row: Fields): SweepRow {
  switch (row.kind) {
    case 'workspace': {
      const outcome = String(row.outcome)
      const verdict = isObject(row.verdict) ? text(row.verdict.reason) : undefined
      const reason = outcome === 'review-required' ? text(row.reason) : verdict
      return {
        outcome,
        changed: outcome !== 'retained' && outcome !== 'skipped',
        line: `${markOf(theme, SWEEP_MARKS, outcome)} ${place(theme, row)}  ${task(theme, row.taskId)}`,
        ...(reason === undefined ? {} : { reason }),
      }
    }
    case 'task-artifacts': {
      const outcome = String(row.outcome)
      return {
        outcome,
        changed: true,
        line: `${markOf(theme, SWEEP_MARKS, outcome)} ${theme.fg('text', 'artifacts')}  ${task(theme, row.taskId)}`,
        ...(outcome === 'review-required' && text(row.reason) !== undefined ? { reason: text(row.reason)! } : {}),
      }
    }
    case 'task-deferred':
      return { outcome: 'deferred', changed: false, line: `${markOf(theme, SWEEP_MARKS, 'deferred')} ${task(theme, row.taskId)}` }
    case 'task-failure':
      return {
        outcome: 'review-required',
        changed: true,
        line: `${markOf(theme, SWEEP_MARKS, 'review-required')} ${task(theme, row.taskId)}`,
        ...(text(row.reason) === undefined ? {} : { reason: text(row.reason)! }),
      }
    default:
      return {
        outcome: 'review-required',
        changed: true,
        line: `${markOf(theme, SWEEP_MARKS, 'review-required')} ${theme.fg('text', 'sweep')}`,
        ...(text(row.reason) === undefined ? {} : { reason: text(row.reason)! }),
      }
  }
}

const SWEEP_ORDER = Object.keys(SWEEP_MARKS)

const counts = (rows: readonly SweepRow[]): string => {
  const byOutcome = new Map<string, number>()
  for (const row of rows) byOutcome.set(row.outcome, (byOutcome.get(row.outcome) ?? 0) + 1)
  return [...byOutcome]
    .toSorted(([left], [right]) => SWEEP_ORDER.indexOf(left) - SWEEP_ORDER.indexOf(right))
    .map(([outcome, count]) => `${count} ${SWEEP_MARKS[outcome]?.[2] ?? outcome}`)
    .join(' · ')
}

const header = (theme: Theme, title: string, rest: string, hint: string): string =>
  `${theme.bold(theme.fg('toolTitle', title))}  ${rest}${hint === '' ? '' : theme.fg('dim', `   ${hint}`)}`

function sweepLines(theme: Theme, receipt: Fields, expanded: boolean, hints: Hints): string[] {
  const rows = objects(receipt.rows).map(row => sweepRow(theme, row))
  if (rows.length === 0) return []
  const changed = rows.filter(row => row.changed)
  const summary = counts(rows)
  const hidden = expanded ? 0 : rows.length - changed.length
  const hint = expanded ? '' : `${hints.keyText(EXPAND)} per i dettagli`
  const lines = [header(theme, 'workspace sweep', theme.fg('muted', `${MOMENTS[String(receipt.moment)] ?? ''} · ${summary}`), hint)]
  for (const row of expanded ? rows : changed) {
    lines.push(`  ${row.line}`)
    if (row.reason !== undefined && (expanded || row.outcome === 'review-required'))
      lines.push(detail(theme, oneLine(row.reason), row.outcome === 'review-required' ? 'error' : 'dim'))
  }
  if (hidden > 0 && changed.length > 0) lines.push(theme.fg('dim', `  ${hidden} kept or skipped`))
  return lines
}

function viewLines(theme: Theme, view: Fields, expanded: boolean, current: unknown): string[] {
  const here = current !== undefined && view.workspaceId === current ? theme.fg('accent', '  current') : ''
  const lines = [`  ${markOf(theme, VIEW_MARKS, view.outcome)} ${place(theme, view)}  ${task(theme, view.taskId)}${here}`]
  if (!expanded) return lines
  if (view.origin === 'managed' && text(view.path) !== undefined) lines.push(detail(theme, shortPath(text(view.path)!)))
  if (text(view.reason) !== undefined) lines.push(detail(theme, oneLine(text(view.reason)!)))
  if (text(view.nextAction) !== undefined) lines.push(detail(theme, `next: ${oneLine(text(view.nextAction)!)}`))
  for (const use of objects(view.uses)) {
    const attempt = isObject(use.execution) ? text(use.execution.attemptId) : undefined
    lines.push(detail(theme, `use ${String(use.access)} · ${String(use.stage)}${attempt === undefined ? '' : ` · attempt ${shortId(attempt)}`}`))
  }
  for (const item of objects(view.pending)) lines.push(detail(theme, `pending ${String(item.kind)} · ${String(item.stage)}`, 'warning'))
  return lines
}

function reportLines(theme: Theme, report: Fields, expanded: boolean, hints: Hints): string[] {
  const hint = expanded ? '' : `${hints.keyText(EXPAND)} per i dettagli`
  const artifacts = text(report.artifacts)
  const artifactsLine = expanded && artifacts !== undefined ? [`  ${theme.fg('dim', `artifacts  ${shortPath(artifacts)}`)}`] : []
  if (report.kind === 'list') {
    const views = objects(report.views)
    const root = text(report.repositoryRoot)
    const current = isObject(report.current) ? report.current.workspaceId : undefined
    const lines = [header(theme, 'workspace', theme.fg('muted', `${root === undefined ? '' : shortPath(root)} · ${views.length} ${views.length === 1 ? 'workspace' : 'workspaces'}`), hint)]
    for (const view of views) lines.push(...viewLines(theme, view, expanded, current))
    return [...lines, ...artifactsLine]
  }
  if (report.kind === 'inspect') {
    const lines = [header(theme, 'workspace inspect', task(theme, report.taskId), hint)]
    const views = objects(report.views)
    if (views.length === 0) lines.push(`  ${theme.fg('dim', 'no workspace records')}`)
    for (const view of views) lines.push(...viewLines(theme, view, expanded, undefined))
    return [...lines, ...artifactsLine]
  }
  if (report.kind === 'check') {
    const lines = [header(theme, 'workspace check', `${task(theme, report.taskId)}  ${theme.fg('dim', 'changes nothing')}`, hint)]
    const assessments = objects(report.assessments)
    if (assessments.length === 0) lines.push(`  ${theme.fg('dim', 'no workspace records')}`)
    for (const assessment of assessments) {
      const completion = isObject(assessment.completion) ? assessment.completion : {}
      const finished = completion.kind === 'finished'
      const verdict = finished ? `finished (${String(completion.rule)})` : `retained (${String(completion.retained)})`
      lines.push(`  ${theme.fg(finished ? 'success' : 'dim', finished ? '✓' : '◌')} ${theme.fg('text', verdict)}  ${place(theme, assessment)}`)
      if (!expanded) continue
      if (text(completion.reason) !== undefined) lines.push(detail(theme, oneLine(text(completion.reason)!)))
      for (const reason of strings(assessment.reasons)) lines.push(detail(theme, `- ${oneLine(reason)}`))
      const target = isObject(assessment.target) ? text(assessment.target.description) : undefined
      if (target !== undefined) lines.push(detail(theme, `target: ${oneLine(target)}`))
      for (const item of strings(assessment.residual)) lines.push(detail(theme, `residual: ${oneLine(item)}`, 'warning'))
      for (const action of strings(assessment.nextActions)) lines.push(detail(theme, `next: ${oneLine(action)}`))
    }
    return lines
  }
  return []
}

// Lines are rebuilt only when the width changes; render() reads memory only. Collapsed rows
// are cut at the edge; expanded ones wrap, so ctrl+o shows every reason and command whole.
class Rows implements Component {
  private cache: { readonly width: number; readonly lines: string[] } | undefined

  constructor(
    private readonly lines: readonly string[],
    private readonly expanded: boolean,
    private readonly theme: Theme,
  ) {}

  render(width: number): string[] {
    if (this.cache?.width === width) return this.cache.lines
    const box = new Box(1, 1, line => this.theme.bg('customMessageBg', line))
    const shown = this.expanded ? this.lines : this.lines.map(line => truncateToWidth(line, Math.max(1, width - 2), '…'))
    box.addChild(new Text(shown.join('\n'), 0, 0))
    const lines = box.render(width)
    this.cache = { width, lines }
    return lines
  }

  invalidate(): void {
    this.cache = undefined
  }
}

const rows = (lines: readonly string[], expanded: boolean, theme: Theme): Component | undefined =>
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
function refusalLines(theme: Theme, refusal: Fields, expanded: boolean, hints: Hints): string[] {
  const reason = text(refusal.reason)
  if (reason === undefined) return []
  const hint = expanded ? '' : `${hints.keyText(EXPAND)} per i dettagli`
  const effect = refusal.endedTurn === true ? 'turn ended' : 'command not run'
  const next = text(refusal.next)
  return [
    header(theme, 'workspace refusal', theme.fg('muted', `review required · ${effect}`), hint),
    `  ${theme.fg('error', '✗')} ${theme.fg('error', oneLine(reason))}`,
    ...(next === undefined ? [] : [detail(theme, `next: ${oneLine(next)}`)]),
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
  const lines = [
    `${theme.fg('accent', '⇄')} ${theme.bold(theme.fg('toolTitle', details.resumed === true ? 'workspace resumed' : 'workspace switched'))}  ${theme.fg('muted', shortId(details.workspaceId))}  ${theme.fg('dim', cwd === undefined ? '' : shortPath(cwd))}`,
    ...(reason === undefined ? [] : [`  ${theme.fg('muted', oneLine(reason))}`]),
  ]
  if (options.expanded && typeof message.content === 'string')
    lines.push('', ...String(plainDeep(message.content)).split('\n').map(line => theme.fg('dim', `  ${line}`)))
  return rows(lines, options.expanded, theme)
}
