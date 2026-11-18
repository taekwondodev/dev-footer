// Transcript rows for dev's `read_url` calls, drawn from the call arguments and `details`
// only, never from model-visible content. A read is two rows: the page asked for, then what
// came back, as its title, how it was retrieved, the range read and what limits it. ctrl+o
// shows the whole address, a redirect's source, every limitation and the text read. A failed
// read is the cause of its error, as in the work rows.
import type { Theme, ToolRenderers } from '@earendil-works/pi-coding-agent'
import { type Component, getCapabilities, hyperlink, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { hinted, oneLine, plain, tokens, toolBackdrop } from './header.ts'
import { ErrorRow } from './rows.ts'

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
// Page facts are untrusted and drawn on one row each.
const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? oneLine(value) : undefined)
const number = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(item => text(item) ?? []) : [])

const EXPAND = 'app.tools.expand'

// Shared by a read's call and result renders: a continuation names no page, so its call row
// shows the one its result reports.
interface ReadState {
  source?: string
}

const hostOf = (url: string): string | undefined => (URL.canParse(url) ? new URL(url).host : undefined)

// An address without its `https://`, opened by the terminal where it supports links. Only a
// parsed http(s) address becomes a link target, so page text cannot write its own sequence.
function address(theme: Theme, url: string): string {
  const label = theme.fg('accent', url.replace(/^https:\/\//, ''))
  if (!getCapabilities().hyperlinks || !URL.canParse(url)) return label
  const target = new URL(url)
  return target.protocol === 'https:' || target.protocol === 'http:' ? hyperlink(label, target.href) : label
}

// A continuation token ends with the offset it resumes from; any other token names none.
const resumeText = (continuation: string): string => {
  const match = /@(\d+)$/.exec(continuation)
  return match === null ? 'continuazione' : `da ${tokens(Number(match[1]))}`
}

class CallRow implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly url: string | undefined,
    private readonly resume: string | undefined,
    private readonly expanded: boolean,
    private readonly state: ReadState,
    private readonly backdrop: (line: string) => string,
  ) {}

  render(width: number): string[] {
    const { theme } = this
    const page = this.url ?? this.state.source
    const parts = [
      ...(page === undefined ? [] : [address(theme, page)]),
      ...(this.resume === undefined ? [] : [theme.fg('dim', this.resume)]),
    ]
    const line = `${theme.fg('toolTitle', theme.bold('read url'))}  ${parts.join(theme.fg('dim', ' · '))}`
    const rows = this.expanded ? wrapTextWithAnsi(line, Math.max(1, width)) : [truncateToWidth(line, width, '…')]
    return rows.map(this.backdrop)
  }

  invalidate(): void {}
}

// Below this room a title would be a few letters, so the facts stand alone.
const TITLE_MIN = 12
const GAP = '  '

// One collapsed row with its hint at the right edge. The facts are kept whole and the title
// takes the room left before them; a row too narrow for both is cut before the hint.
class FactsRow implements Component {
  constructor(
    private readonly theme: Theme,
    private readonly title: string | undefined,
    private readonly facts: string,
    private readonly hint: string,
    private readonly backdrop: (line: string) => string,
  ) {}

  render(width: number): string[] {
    const room = width - visibleWidth(this.hint) - 3 - visibleWidth(this.facts) - GAP.length
    const title = this.title === undefined || room < TITLE_MIN ? '' : this.theme.fg('muted', truncateToWidth(this.title, room, '…')) + GAP
    return [this.backdrop(truncateToWidth(hinted(title + this.facts, this.hint, width), width, '…'))]
  }

  invalidate(): void {}
}

function range(details: Fields): string | undefined {
  const end = number(details.end)
  const total = number(details.totalChars)
  if (end === undefined || total === undefined) return undefined
  const offset = number(details.offset) ?? 0
  return offset === 0 && end === total ? `${tokens(total)} caratteri` : `${tokens(offset)}–${tokens(end)} di ${tokens(total)} caratteri`
}

// What came back: the host a redirect led to, how the page was retrieved, a status that is
// not a success, the range read, whether more follows and how many limitations dev reported.
// Only a failed status and a page cut at a size limit are colored.
function factsLine(theme: Theme, asked: string | undefined, details: Fields, limitations: readonly string[]): string {
  const dim = (value: string) => theme.fg('dim', value)
  const final = text(details.finalUrl)
  const moved = final !== undefined && asked !== undefined && hostOf(final) !== hostOf(asked) ? hostOf(final) : undefined
  const status = number(details.status)
  const span = range(details)
  const more = text(details.continuation) !== undefined
  const last = details.complete === true && (number(details.offset) ?? 0) > 0
  return [
    ...(moved === undefined ? [] : [dim(`→ ${moved}`)]),
    ...(text(details.method) === undefined ? [] : [dim(text(details.method)!)]),
    ...(status === undefined || (status >= 200 && status < 300) ? [] : [theme.fg('warning', `HTTP ${status}`)]),
    ...(span === undefined ? [] : [dim(span)]),
    ...(more ? [dim('continua')] : details.complete === true ? (last ? [dim('fine')] : []) : [theme.fg('warning', 'tagliata')]),
    ...(limitations.length === 0 ? [] : [dim(`${limitations.length} ${limitations.length === 1 ? 'limite' : 'limiti'}`)]),
  ].join(dim(' · '))
}

// A continuation's call row already shows the source its result reports.
function expandedLines(theme: Theme, asked: string | undefined, details: Fields, limitations: readonly string[]): string[] {
  const title = text(details.title)
  const final = text(details.finalUrl)
  const facts = factsLine(theme, asked, details, limitations)
  const lines = [title === undefined ? facts : `${theme.fg('muted', title)}${GAP}${facts}`]
  if (final !== undefined && asked !== undefined && final !== asked) lines.push(`${theme.fg('dim', '  source  ')}${address(theme, final)}`)
  for (const limitation of limitations) lines.push(theme.fg('dim', `  limite  ${limitation}`))
  const page = typeof details.text === 'string' ? plain(details.text).trimEnd() : ''
  if (page !== '') lines.push('', ...page.split('\n').map(row => theme.fg('toolOutput', row)))
  return lines
}

const failure = (details: Fields, content: readonly { readonly type: string; readonly text?: string }[]): string => {
  const error = typeof details.error === 'string' ? details.error : undefined
  if (error === undefined) return plain(content.flatMap(part => (part.type === 'text' && part.text !== undefined ? [part.text] : [])).join('\n'))
  const limitations = Array.isArray(details.limitations) ? details.limitations.filter(item => typeof item === 'string') : []
  return plain([error, ...limitations].join('\n'))
}

export function readUrlRenderers(): ToolRenderers {
  return {
    renderCall: (args, theme, context) => {
      const input = isObject(args) ? args : {}
      const continuation = text(input.continuation)
      return new CallRow(theme, text(input.url), continuation === undefined ? undefined : resumeText(continuation), context.expanded, context.state as ReadState, toolBackdrop(theme, context))
    },
    renderResult: (result, options, theme, context) => {
      const details = isObject(result.details) ? result.details : {}
      if (context.isError || details.outcome === 'failed') return new ErrorRow(failure(details, result.content), options.expanded, theme, context)
      const state = context.state as ReadState
      const source = text(details.finalUrl) ?? text(details.requestedUrl)
      if (source !== undefined) state.source = source
      const asked = isObject(context.args) ? text(context.args.url) : undefined
      const limitations = strings(details.limitations)
      if (options.expanded) return new Text(expandedLines(theme, asked, details, limitations).join('\n'), 0, 0)
      const hint = theme.fg('dim', `${context.keyText(EXPAND)} per leggere`)
      return new FactsRow(theme, text(details.title), factsLine(theme, asked, details, limitations), hint, toolBackdrop(theme, context))
    },
  }
}
