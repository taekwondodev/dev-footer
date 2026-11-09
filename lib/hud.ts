// The HUD below the subagent list: a blank row, then a two-by-two grid. The left column
// is place (primary on row 1, secondary on row 2), the right column is the model and its
// telemetry, right-aligned. Icons carry one calm hue and values carry luminance; any other
// color marks state.
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'
import { hyperlink, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { oneLine, plainDeep } from './header.ts'
import type { Diff, PullRequest, PullRequestState } from './repo.ts'

// Ghostty maps these glyphs to JetBrainsMono Nerd Font (not Mono). Each icon takes one
// column, then two spaces for its overhang and the gap; dev's ADR 0006 records the font.
export const ICON = {
  folder: '\u{f07b}',
  branch: '\u{f418}',
  pullRequest: '\u{f407}',
  worktrees: '\u{f0645}',
  context: '\u{ee9c}',
  warm: '\u{f0954}',
  cold: '\u{f0717}',
} as const

const ICON_GAP = '  '
const GROUP_GAP = '   '
const SPARK_LEVELS = '⡀⣀⣄⣤⣦⣶⣷⣿'
// Centered horizontal lines: Ghostty stretches block and vertical glyphs over the cell.
const BAR = { full: '━', empty: '─' } as const
const NARROW = 100
// Pine in rose-pine-moon: the calm hue of icons and of the context gauge at rest.
const CALM: ThemeColor = 'syntaxType'
const CACHE_EXPIRING_MS = 60_000
const PULL_REQUEST_COLOR: Record<PullRequestState, ThemeColor> = {
  open: 'warning',
  draft: 'muted',
  merged: 'syntaxKeyword',
  closed: 'error',
}

export interface Place {
  readonly folder: string
  readonly repoUrl?: string
  readonly branch?: string
  readonly pullRequest?: PullRequest
  readonly diff?: Diff
  readonly worktrees: number
  readonly session?: string
  readonly model?: string
  readonly thinking?: string
}

export type CacheClock = { readonly remainingMs: number } | 'cold' | undefined

export interface Telemetry {
  readonly context?: { readonly percent: number | null }
  readonly cost: number
  readonly cacheHit?: number
  readonly clock: CacheClock
  readonly runs: readonly number[]
}

// Each level drops one more element, in the order of the HUD decision; a frame uses the
// first level at which both rows fit, so the grid keeps one shape. Below 100 columns the
// grid starts at the compact level.
interface Detail {
  readonly secondary: boolean
  readonly pullRequest: boolean
  readonly cacheHit: boolean
  readonly spark: boolean
  readonly gauge: number
  readonly cost: boolean
  readonly diff: boolean
  readonly thinking: boolean
}
const FULL: Detail = { secondary: true, pullRequest: true, cacheHit: true, spark: true, gauge: 10, cost: true, diff: true, thinking: true }
const COMPACT: Detail = { ...FULL, secondary: false, pullRequest: false, cacheHit: false, spark: false, gauge: 6 }
const DETAILS: readonly Detail[] = [
  FULL,
  COMPACT,
  { ...COMPACT, cost: false },
  { ...COMPACT, cost: false, diff: false },
  { ...COMPACT, cost: false, diff: false, gauge: 0 },
  { ...COMPACT, cost: false, diff: false, gauge: 0, thinking: false },
]

export function formatClock(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

const link = (text: string, url: string | undefined, linked: boolean): string =>
  url !== undefined && linked ? hyperlink(text, url) : text

const icon = (theme: Theme, glyph: string, color: ThemeColor = CALM): string => theme.fg(color, glyph) + ICON_GAP

function spread(left: string, right: string, width: number): string {
  if (right === '') return left
  return left + ' '.repeat(Math.max(2, width - visibleWidth(left) - visibleWidth(right))) + right
}

export const contextTone = (percent: number): ThemeColor | undefined =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : undefined

export function contextBar(theme: Theme, percent: number, cells: number): string {
  const filled = Math.round((Math.min(100, Math.max(0, percent)) / 100) * cells)
  return theme.fg(contextTone(percent) ?? CALM, BAR.full.repeat(filled)) + theme.fg('border', BAR.empty.repeat(cells - filled))
}

// The latest run stands out from the history.
export function sparkline(theme: Theme, runs: readonly number[]): string {
  const peak = Math.max(...runs)
  const cells = runs.map(tokens => SPARK_LEVELS[peak === 0 ? 0 : Math.round((tokens / peak) * (SPARK_LEVELS.length - 1))]!)
  return theme.fg('muted', cells.slice(0, -1).join('')) + theme.fg('success', cells.at(-1)!)
}

function placeLeft(theme: Theme, place: Place, detail: Detail, linked: boolean): string {
  const parts = [link(icon(theme, ICON.folder) + theme.bold(theme.fg('text', place.folder)), place.repoUrl, linked)]
  if (place.branch !== undefined) {
    const url = place.repoUrl === undefined ? undefined : `${place.repoUrl}/tree/${encodeURI(place.branch)}`
    parts.push(link(icon(theme, ICON.branch, 'accent') + theme.fg('text', place.branch), url, linked))
  }
  const pr = place.pullRequest
  if (detail.pullRequest && pr !== undefined) {
    const color = PULL_REQUEST_COLOR[pr.state]
    parts.push(link(icon(theme, ICON.pullRequest, color) + theme.fg(color, `#${pr.number}`), pr.url, linked))
  }
  const diff = place.diff
  if (detail.diff && diff !== undefined && (diff.added > 0 || diff.removed > 0))
    parts.push(`${theme.fg('toolDiffAdded', `+${diff.added}`)} ${theme.fg('toolDiffRemoved', `−${diff.removed}`)}`)
  return parts.join(GROUP_GAP)
}

function placeRight(theme: Theme, place: Place, detail: Detail): string {
  const parts: string[] = []
  if (place.model !== undefined) parts.push(theme.fg('text', place.model))
  if (detail.thinking && place.thinking !== undefined)
    parts.push(theme.getThinkingBorderColor(place.thinking as Parameters<Theme['getThinkingBorderColor']>[0])(place.thinking))
  return parts.join(ICON_GAP)
}

function secondaryLeft(theme: Theme, place: Place, detail: Detail): string {
  if (!detail.secondary) return ''
  const parts: string[] = []
  if (place.session !== undefined) parts.push(theme.italic(theme.fg('muted', place.session)))
  if (place.worktrees > 0) parts.push(icon(theme, ICON.worktrees) + theme.fg('muted', `${place.worktrees}`))
  return parts.join(GROUP_GAP)
}

function telemetryRight(theme: Theme, telemetry: Telemetry, detail: Detail): string {
  const groups: string[] = []
  const percent = telemetry.context?.percent
  if (telemetry.context !== undefined) {
    let group = icon(theme, ICON.context)
    if (detail.gauge > 0) group += `${contextBar(theme, percent ?? 0, detail.gauge)} `
    group += percent === null || percent === undefined ? theme.fg('dim', '?') : theme.fg(contextTone(percent) ?? 'text', `${Math.round(percent)}%`)
    groups.push(group)
  }
  if (detail.cost && telemetry.cost > 0) groups.push(theme.fg('text', `$${telemetry.cost.toFixed(2)}`))
  if (detail.cacheHit && telemetry.cacheHit !== undefined) groups.push(theme.fg('muted', `${telemetry.cacheHit.toFixed(1)}%`))
  if (telemetry.clock === 'cold') groups.push(icon(theme, ICON.cold, 'dim') + theme.fg('dim', 'stale'))
  else if (telemetry.clock !== undefined) {
    const tone = telemetry.clock.remainingMs < CACHE_EXPIRING_MS ? 'warning' : 'success'
    groups.push(icon(theme, ICON.warm, tone) + theme.fg('muted', formatClock(telemetry.clock.remainingMs)))
  }
  if (detail.spark && telemetry.runs.length > 0) groups.push(sparkline(theme, telemetry.runs))
  return groups.join(GROUP_GAP)
}

// Folder, branch, session and links come from the checkout, git and gh: drawn on one row,
// with no control character that could drive the terminal.
export function hudRows(theme: Theme, untrusted: Place, telemetry: Telemetry, width: number, linked: boolean): string[] {
  const place = plainDeep(untrusted, oneLine) as Place
  const levels = width < NARROW ? DETAILS.slice(1) : DETAILS
  const build = (detail: Detail) => [
    spread(placeLeft(theme, place, detail, linked), placeRight(theme, place, detail), width),
    spread(secondaryLeft(theme, place, detail), telemetryRight(theme, telemetry, detail), width),
  ]
  const fitting = levels.map(build).find(rows => rows.every(row => visibleWidth(row) <= width))
  const rows = fitting ?? build(levels.at(-1) ?? COMPACT).map(row => truncateToWidth(row, width, '…'))
  return ['', ...rows]
}
