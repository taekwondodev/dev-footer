// Shared by the subagent list and the transcript rows: titles, task text, glyphs and
// compact numbers, so both surfaces name a child the same way.
import type { Theme, ThemeColor } from '@earendil-works/pi-coding-agent'

export type Status = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | 'unknown'

export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
export const SPINNER_INTERVAL_MS = 100

export interface Role {
  readonly skill?: string
  readonly coordinator?: boolean
  readonly access?: string
}

// Child, command and session text is untrusted: its control characters, which could drive
// the terminal (OSC 52 clipboard writes, titles, cursor moves), become spaces. Newlines and
// tabs stay. Renderers apply it where payloads enter, so drawing code sees clean text.
export const plain = (value: string): string => value.replaceAll(/[^\P{Cc}\n\t]+/gu, ' ')

// For fields drawn on one row: newlines and tabs become spaces too.
export const oneLine = (value: string): string => value.replaceAll(/\p{Cc}+/gu, ' ')

export const plainDeep = (value: unknown, clean: (value: string) => string = plain): unknown => {
  if (typeof value === 'string') return clean(value)
  if (Array.isArray(value)) return value.map(item => plainDeep(item, clean))
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), plainDeep(item, clean)]))
}

export const title = (role: Role): string =>
  role.skill ?? (role.coordinator === true ? 'coordinator' : role.access === 'write' ? 'writer' : 'reader')

export const taskText = (taskId: string): string => taskId.replaceAll('-', ' ')

export const shortModel = (model: string): string => model.slice(model.indexOf('/') + 1).replace(/^claude-/, '')

const GLYPH: Record<Status, readonly [string, ThemeColor]> = {
  running: ['⠹', 'accent'],
  waiting: ['◌', 'dim'],
  completed: ['✓', 'success'],
  failed: ['✗', 'error'],
  cancelled: ['⊘', 'dim'],
  unknown: ['?', 'dim'],
}

export const glyph = (theme: Theme, status: Status, frame = 1): string => {
  const [mark, color] = GLYPH[status]
  return theme.fg(color, status === 'running' ? SPINNER[frame % SPINNER.length]! : mark)
}

export const duration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, '0')
  return hours > 0 ? `${hours}h ${String(minutes).padStart(2, '0')}m` : `${minutes}m ${rest}s`
}

// The transcript's duration: no fixed width to keep, so no leading zero unit.
export const shortDuration = (ms: number): string => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return seconds < 60 ? `${seconds}s` : duration(ms)
}

export const tokens = (count: number): string => {
  if (count >= 1e6) return `${(count / 1e6).toFixed(2)}M`
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}k`
  return `${count}`
}

export const contextColor = (percent: number): ThemeColor | undefined =>
  percent >= 85 ? 'error' : percent >= 60 ? 'warning' : undefined

export const STATUS_WORDS: Record<Status, string> = {
  running: 'running',
  waiting: 'waiting',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'unknown',
}

export const STATUS_ORDER: Record<Status, number> = {
  running: 0,
  waiting: 1,
  failed: 2,
  cancelled: 3,
  unknown: 4,
  completed: 5,
}

// A child's name in the transcript: `<title>  <task>`.
export const childHeader = (theme: Theme, role: Role, taskId: string): string =>
  `${theme.bold(theme.fg('accent', title(role)))}  ${theme.fg('text', taskText(taskId))}`

// The thinking level in the color Pi uses for the editor border, as in the HUD.
export const effortText = (theme: Theme, effort: string): string =>
  theme.getThinkingBorderColor(effort as Parameters<Theme['getThinkingBorderColor']>[0])(effort)
