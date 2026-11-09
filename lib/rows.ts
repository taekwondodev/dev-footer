// Transcript rows for dev's `work` calls and `dev/work-outcome` messages, drawn from the
// call arguments and `details` only, never from model-visible content. A delegation is one
// static launch row; an outcome is one block per child with its tool trail and answer on
// ctrl+o; other actions and command outcomes are one compact row each.
import type { MessageRenderer, Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import { Box, type Component, Spacer, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import {
  childHeader,
  effortText,
  glyph,
  plain,
  plainDeep,
  type Role,
  shortModel,
  type Status,
  STATUS_ORDER,
  STATUS_WORDS,
  shortDuration,
  taskText,
  title,
  tokens,
} from './header.ts'
import { cachedSession, sessionRead } from './session.ts'

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown'])
const statusOf = (value: unknown): Status => (typeof value === 'string' && STATUSES.has(value) ? (value as Status) : 'unknown')

const ANSWER_LINES = 22
const EXPAND = 'app.tools.expand'

interface Hints {
  readonly keyText: (binding: typeof EXPAND) => string
}

// What earlier rows taught about an attempt, so later rows can name it by id.
interface Known {
  readonly role: Role
  readonly taskId: string
  readonly command?: string
}
const known = new Map<string, Known>()
const KNOWN_ATTEMPTS = 512

const remember = (id: string, value: Known): void => {
  known.delete(id)
  known.set(id, value)
  while (known.size > KNOWN_ATTEMPTS) known.delete(known.keys().next().value!)
}

const firstLine = (value: string): string => value.split('\n').find(line => line.trim() !== '')?.trim() ?? ''

const invokedSkill = (prompt: unknown): string | undefined => {
  const match = typeof prompt === 'string' ? /^\s*\/skill:(\S+)/.exec(prompt) : null
  return match?.[1]
}

const roleOf = (fields: Fields): Role => ({
  ...(text(fields.invokedSkill) === undefined ? {} : { skill: text(fields.invokedSkill)! }),
  coordinator: fields.coordinator === true,
  ...(text(fields.access) === undefined ? {} : { access: text(fields.access)! }),
})

const subject = (theme: Theme, entry: Known | undefined, id: unknown): string => {
  if (entry === undefined) return theme.fg('muted', typeof id === 'string' ? id.slice(0, 8) : '')
  if (entry.command !== undefined) return theme.fg('muted', `$ ${firstLine(entry.command)}`)
  return `${theme.fg('accent', title(entry.role))} ${theme.fg('muted', taskText(entry.taskId))}`
}

const callLine = (theme: Theme, action: string, rest = ''): string =>
  theme.fg('toolTitle', theme.bold(`work ${action}`)) + (rest === '' ? '' : `  ${rest}`)

const counts = (statuses: readonly Status[]): string => {
  const byStatus = new Map<Status, number>()
  for (const status of statuses) byStatus.set(status, (byStatus.get(status) ?? 0) + 1)
  return [...byStatus]
    .toSorted(([left], [right]) => STATUS_ORDER[left] - STATUS_ORDER[right])
    .map(([status, count]) => `${count} ${STATUS_WORDS[status]}`)
    .join(' · ')
}

const kilobytes = (value: string): string => `${(Buffer.byteLength(value) / 1024).toFixed(1)} KB`

// Shared by a launch's call and result renders: the result adds what dev resolved, such as
// the model, to the same row.
interface LaunchState {
  launch?: string
}

class LaunchRow implements Component {
  constructor(
    private readonly header: string,
    private readonly state: LaunchState,
  ) {}

  render(width: number): string[] {
    const line = this.state.launch === undefined ? this.header : `${this.header}   ${this.state.launch}`
    return [truncateToWidth(line, width, '…')]
  }

  invalidate(): void {}
}

function renderCall(args: unknown, theme: Theme, state: LaunchState): Component {
  const input = isObject(args) ? args : {}
  const action = text(input.action) ?? 'work'
  switch (action) {
    case 'delegate': {
      const skill = text(input.skill) ?? invokedSkill(input.prompt)
      const role: Role = {
        ...(skill === undefined ? {} : { skill }),
        coordinator: input.coordinate === true,
        access: text(input.access) ?? 'read-only',
      }
      return new LaunchRow(childHeader(theme, role, text(input.taskId) ?? ''), state)
    }
    case 'process':
      return new LaunchRow(
        `${theme.fg('toolTitle', theme.bold(`$ ${firstLine(text(input.command) ?? '')}`))}  ${theme.fg('muted', taskText(text(input.taskId) ?? ''))}`,
        state,
      )
    case 'inspect': {
      const stream = text(input.stream)
      const at = stream === undefined ? '' : theme.fg('dim', ` · ${stream} da ${number(input.offset) ?? 0}`)
      return new Text(callLine(theme, 'inspect', subject(theme, known.get(String(input.id)), input.id) + at), 0, 0)
    }
    case 'cancel':
      return new Text(
        callLine(theme, 'cancel', input.id === undefined ? theme.fg('muted', 'tutto') : subject(theme, known.get(String(input.id)), input.id)),
        0,
        0,
      )
    default:
      return new Text(callLine(theme, action), 0, 0)
  }
}

const attemptState = (theme: Theme, attempt: Fields): string => {
  const status = statusOf(attempt.status)
  const exitCode = number(attempt.exitCode)
  const parts = [STATUS_WORDS[status]]
  if (exitCode !== undefined) parts.push(`exit ${exitCode}`)
  const error = text(attempt.error)
  return `${glyph(theme, status)} ${theme.fg('dim', parts.join(' · '))}${error === undefined ? '' : `  ${theme.fg('error', firstLine(error))}`}`
}

function launchMeta(theme: Theme, attempt: Fields): string {
  const requested = isObject(attempt.requested) ? attempt.requested : {}
  const model = text(requested.model) ?? text(attempt.model)
  const effort = text(requested.effort)
  const parts = [
    ...(model === undefined ? [] : [theme.fg('dim', shortModel(model))]),
    ...(effort === undefined ? [] : [effortText(theme, effort)]),
    ...(text(attempt.access) === undefined ? [] : [theme.fg('dim', text(attempt.access)!)]),
  ]
  return parts.join(theme.fg('dim', ' · '))
}

function resultLines(args: Fields, details: Fields, expanded: boolean, theme: Theme, hints: Hints, state: LaunchState): string[] {
  const action = text(args.action)
  const expand = theme.fg('dim', `   ${hints.keyText(EXPAND)} per leggere`)
  if (details.kind === 'attempt' && isObject(details.attempt)) {
    const { attempt } = details
    const id = text(attempt.id)
    if (id !== undefined && action !== 'cancel')
      remember(id, {
        role: roleOf(attempt),
        taskId: text(attempt.taskId) ?? '',
        ...(action === 'process' && text(args.command) !== undefined ? { command: text(args.command)! } : {}),
      })
    if (action === 'delegate') {
      state.launch = launchMeta(theme, attempt)
      return []
    }
    if (action === 'process') return []
    return [attemptState(theme, attempt)]
  }
  if (details.kind === 'snapshot' && isObject(details.snapshot)) {
    const records = Array.isArray(details.snapshot.records) ? details.snapshot.records.filter(isObject) : []
    const summary = records.length === 0 ? 'no attempts' : counts(records.map(record => statusOf(record.status)))
    const blocked = details.snapshot.agentsBlocked === true ? theme.fg('warning', ' · new agents blocked') : ''
    const lines = [theme.fg('dim', summary) + blocked]
    if (expanded)
      for (const record of records)
        lines.push(`  ${glyph(theme, statusOf(record.status))} ${subject(theme, known.get(String(record.id)) ?? { role: roleOf(record), taskId: text(record.taskId) ?? '' }, record.id)}`)
    return lines
  }
  if (details.kind === 'inspection' && isObject(details.inspection)) {
    const { inspection } = details
    const id = text(inspection.id)
    if (id !== undefined && !known.has(id)) remember(id, { role: roleOf(inspection), taskId: text(inspection.taskId) ?? '' })
    const lines = [attemptState(theme, inspection)]
    if (expanded)
      for (const [label, value] of [
        ['task', text(inspection.workflowTaskId)],
        ['worktree', isObject(inspection.worktree) ? text(inspection.worktree.path) : undefined],
        ['cwd', text(inspection.cwd)],
      ] as const)
        if (value !== undefined) lines.push(theme.fg('dim', `  ${label}  ${value}`))
    return lines
  }
  if (details.kind === 'log' && isObject(details.log)) {
    const { log } = details
    if (log.available !== true) return [theme.fg('dim', text(log.reason) ?? 'log unavailable')]
    const page = typeof log.text === 'string' ? log.text : ''
    const next = number(log.nextOffset)
    const line = theme.fg('dim', `${kilobytes(page)} letti · ${next === undefined ? 'fine' : `continua da ${next}`}`)
    return expanded ? [line, '', ...page.split('\n').map(row => theme.fg('toolOutput', row))] : [line + expand]
  }
  if (details.kind === 'dispatch' && isObject(details.dispatch)) {
    const { dispatch } = details
    const fallback = isObject(dispatch.default) ? text(dispatch.default.model) : undefined
    const rules = isObject(dispatch.rules) ? Object.entries(dispatch.rules) : []
    const lines = [theme.fg('dim', `default ${fallback === undefined ? 'Pi' : shortModel(fallback)} · ${rules.length} regole`)]
    if (expanded)
      for (const [name, rule] of rules) {
        const model = isObject(rule) ? text(rule.model) : undefined
        const effort = isObject(rule) ? text(rule.effort) : undefined
        lines.push(theme.fg('dim', `  ${name}  ${[model === undefined ? undefined : shortModel(model), effort].filter(Boolean).join(' · ')}`))
      }
    return lines
  }
  return []
}

export function workRenderers(): ToolRenderers {
  return {
    renderCall: (args, theme, context) => renderCall(plainDeep(args), theme, context.state as LaunchState),
    renderResult: (result, options, theme, context) => {
      if (context.isError) {
        const message = result.content.flatMap(part => (part.type === 'text' ? [part.text] : [])).join('\n')
        return new Text(theme.fg('error', firstLine(plain(message))), 0, 0)
      }
      const args = plainDeep(context.args)
      const details = plainDeep(result.details)
      const lines = resultLines(isObject(args) ? args : {}, isObject(details) ? details : {}, options.expanded, theme, context, context.state as LaunchState)
      return new Text(lines.join('\n'), 0, 0)
    },
  }
}

// Collapsed result line: a workflow result contract shows format, status and list sizes.
export function resultSummary(answer: string): string {
  const fenced = /^```json\n([\s\S]*?)\n```/.exec(answer.trimStart())
  if (fenced !== null) {
    try {
      const value: unknown = JSON.parse(fenced[1]!)
      if (isObject(value) && text(value.format) !== undefined && text(value.status) !== undefined) {
        const lists = Object.entries(value)
          .filter(([, item]) => Array.isArray(item))
          .map(([key, item]) => `${(item as unknown[]).length} ${key}`)
        // JSON decoding can turn escapes back into controls after the payload was cleaned.
        return plain([value.format, value.status, ...lists].join(' · '))
      }
    } catch {}
  }
  return firstLine(answer)
}

interface Outcome {
  readonly entry: Fields
  readonly facts: Fields
}

const outcomesOf = (details: unknown): Outcome[] => {
  if (!isObject(details) || !Array.isArray(details.outcomes)) return []
  const facts = Array.isArray(details.children) ? details.children.filter(isObject) : []
  return details.outcomes.filter(isObject).map(entry => ({ entry, facts: facts.find(item => item.id === entry.id) ?? {} }))
}

const resultLog = (entry: Fields): Fields | undefined =>
  (Array.isArray(entry.logs) ? entry.logs.filter(isObject) : []).find(log => log.stream === 'result' && log.available === true)

// The whole answer: the outcome's own read when it was not cut, otherwise the session file.
function answerOf(outcome: Outcome, load: boolean): string | undefined {
  const log = resultLog(outcome.entry)
  if (log !== undefined && log.truncated !== true && typeof log.text === 'string' && log.text.trim() !== '') return log.text
  const path = text(outcome.facts.sessionFile)
  if (path === undefined) return undefined
  const read = load ? sessionRead(path) : cachedSession(path)
  return read?.state === 'ready' ? read.answer : undefined
}

const needsSession = (outcome: Outcome, expanded: boolean): boolean => {
  if (outcome.entry.kind !== 'agent') return false
  const log = resultLog(outcome.entry)
  return expanded || log === undefined || log.truncated === true
}

function metaLine(theme: Theme, { entry, facts }: Outcome): string {
  const usage = isObject(entry.usage) ? number(entry.usage.total) : undefined
  const started = number(facts.startedAt)
  const completed = number(facts.completedAt)
  const turns = number(facts.turns)
  const toolUses = number(facts.toolUses)
  const muted = (value: string) => theme.fg('muted', value)
  const parts = [
    ...(text(entry.model) === undefined ? [] : [muted(shortModel(text(entry.model)!))]),
    ...(text(facts.effort) === undefined ? [] : [effortText(theme, text(facts.effort)!)]),
    ...(turns === undefined ? [] : [muted(`${turns} ${turns === 1 ? 'turn' : 'turns'}`)]),
    ...(toolUses === undefined || toolUses === 0 ? [] : [muted(`${toolUses} ${toolUses === 1 ? 'call' : 'calls'}`)]),
    ...(usage === undefined ? [] : [muted(`${tokens(usage)} tokens`)]),
    ...(started === undefined || completed === undefined ? [] : [muted(shortDuration(completed - started))]),
  ]
  return parts.join(muted(' · '))
}

function trailLines(theme: Theme, outcome: Outcome): string[] {
  const path = text(outcome.facts.sessionFile)
  const read = path === undefined ? undefined : cachedSession(path)
  if (read === undefined || read.state === 'missing') return [theme.fg('dim', 'child session unavailable')]
  if (read.state === 'loading') return [theme.fg('dim', '…')]
  if (read.state === 'oversized') return [theme.fg('dim', `child session too large (${(read.bytes / 1024 / 1024).toFixed(1)} MB)`)]
  if (read.trail.length === 0) return [theme.fg('dim', 'no tools used')]
  return read.trail.map((calls, index) => theme.fg('dim', `${String(index + 1).padEnd(4)}${calls.join(' · ')}`))
}

function childBlock(theme: Theme, outcome: Outcome, expanded: boolean, hints: Hints, width: number): Component[] {
  const { entry } = outcome
  const status = statusOf(entry.status)
  const header = [`${glyph(theme, status)} ${childHeader(theme, roleOf(entry), text(entry.taskId) ?? '')}`, `  ${metaLine(theme, outcome)}`]
  const error = text(entry.error)
  const answer = answerOf(outcome, false)
  if (!expanded) {
    let tail: string
    if (status === 'failed' && error !== undefined) tail = theme.fg('error', firstLine(error))
    else if (answer !== undefined) tail = theme.fg('muted', resultSummary(answer))
    else tail = theme.fg('dim', error === undefined ? '…' : firstLine(error))
    // The hint sits at the right edge; the summary is cut before it.
    const hint = theme.fg('dim', hints.keyText(EXPAND))
    const summary = truncateToWidth(`${theme.fg('dim', '└ ')}${tail}`, Math.max(1, width - visibleWidth(hint) - 3), '…')
    const line = summary + ' '.repeat(Math.max(3, width - visibleWidth(summary) - visibleWidth(hint))) + hint
    return [new Text([...header, truncateToWidth(line, width, '…')].join('\n'), 0, 0)]
  }
  const parts: Component[] = [new Text(header.join('\n'), 0, 0), new Spacer(1)]
  parts.push(new Text(theme.fg('muted', 'Child work'), 2, 0), new Text(trailLines(theme, outcome).join('\n'), 2, 0), new Spacer(1))
  parts.push(new Text(theme.fg('muted', 'Answer'), 2, 0))
  if (answer === undefined) parts.push(new Text(error === undefined ? theme.fg('dim', '…') : theme.fg('error', error), 2, 0))
  else {
    const lines = answer.split('\n')
    const shown = lines.slice(0, ANSWER_LINES).map(line => theme.fg('text', line))
    if (lines.length > ANSWER_LINES) shown.push(theme.fg('dim', `… ${lines.length - ANSWER_LINES} righe in più`))
    parts.push(new Text(shown.join('\n'), 2, 0))
  }
  return parts
}

function commandRow(theme: Theme, { entry, facts }: Outcome, expanded: boolean, hints: Hints): Component {
  const status = statusOf(entry.status)
  const exitCode = number(entry.exitCode)
  const failed = status === 'failed' || (exitCode !== undefined && exitCode !== 0)
  const mark = status === 'completed' && failed ? theme.fg('error', '✗') : glyph(theme, status)
  const id = text(entry.id)
  const command = id === undefined ? undefined : known.get(id)?.command
  const name = command === undefined ? `$ ${taskText(text(entry.taskId) ?? '')}` : `$ ${firstLine(command)}`
  const started = number(facts.startedAt)
  const completed = number(facts.completedAt)
  const meta = [
    ...(exitCode === undefined ? [] : [`exit ${exitCode}`]),
    ...(started === undefined || completed === undefined ? [] : [shortDuration(completed - started)]),
    `${hints.keyText(EXPAND)} per l'output`,
  ]
  const lines = [`${mark} ${theme.fg('toolTitle', theme.bold(name))}${theme.fg('dim', `  ${meta.join(' · ')}`)}`]
  if (text(entry.error) !== undefined) lines.push(theme.fg('error', `  ${firstLine(text(entry.error)!)}`))
  if (expanded)
    for (const log of Array.isArray(entry.logs) ? entry.logs.filter(isObject) : [])
      if (log.available === true && typeof log.text === 'string' && log.text !== '')
        lines.push('', theme.fg('muted', `  ${String(log.stream)}`), ...log.text.trimEnd().split('\n').map(row => theme.fg('toolOutput', `  ${row}`)))
  return new Text(lines.join('\n'), 0, 0)
}

// Lines are rebuilt only when the width or a session read changes; render() reads memory only.
class OutcomeView implements Component {
  private cache: { readonly width: number; readonly key: string; readonly lines: string[] } | undefined

  constructor(
    private readonly outcomes: readonly Outcome[],
    private readonly expanded: boolean,
    private readonly theme: Theme,
    private readonly hints: Hints,
  ) {}

  private key(): string {
    return this.outcomes
      .map(outcome => {
        const path = text(outcome.facts.sessionFile)
        return path === undefined ? '' : (cachedSession(path)?.state ?? '')
      })
      .join('|')
  }

  render(width: number): string[] {
    const key = this.key()
    if (this.cache?.width === width && this.cache.key === key) return this.cache.lines
    const box = new Box(1, 1, line => this.theme.bg('customMessageBg', line))
    this.outcomes.forEach((outcome, index) => {
      if (index > 0) box.addChild(new Spacer(1))
      if (outcome.entry.kind === 'process') box.addChild(commandRow(this.theme, outcome, this.expanded, this.hints))
      else for (const part of childBlock(this.theme, outcome, this.expanded, this.hints, width - 2)) box.addChild(part)
    })
    const lines = box.render(width)
    this.cache = { width, key, lines }
    return lines
  }

  invalidate(): void {
    this.cache = undefined
  }
}

export const outcomeRenderer: MessageRenderer = (message, options, theme) => {
  const outcomes = outcomesOf(plainDeep(message.details))
  if (outcomes.length === 0) return undefined
  for (const outcome of outcomes) {
    const path = text(outcome.facts.sessionFile)
    if (path !== undefined && needsSession(outcome, options.expanded)) sessionRead(path)
  }
  return new OutcomeView(outcomes, options.expanded, theme, options)
}
