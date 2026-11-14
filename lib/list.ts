// The subagent list below the editor: one aligned row per child of the current batch, leaves under their coordinator, at most five
// rows; running commands follow the live rows, then settled rows, overflow and blocking notices.
import type { Theme } from '@earendil-works/pi-coding-agent'
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import {
  contextColor,
  duration,
  glyph,
  shortModel,
  STATUS_ORDER,
  STATUS_WORDS,
  type Status,
  taskText,
  title,
} from './header.ts'
import { type Activity, type Child, isActive, type WorkView } from './view.ts'

export const LIST_ROWS = 5
const NARROW = 100
const TASK_COLUMNS = { wide: 34, narrow: 18 } as const
const MIN_TASK = 8
const MIN_ACTIVITY = 6
// Cells kept for the activity before the task gives up any of its column.
const ACTIVITY_RESERVE = 14
const LEAF = '   └ '

export const activityLabel = (activity: Activity): string => {
  switch (activity.kind) {
    case 'tool':
      return activity.target === undefined ? activity.name : `${activity.name} ${activity.target}`
    case 'thinking':
      return 'thinking…'
    case 'writing':
      return 'writing…'
    case 'retrying':
      return `retrying: ${activity.message}`
  }
}

// Running work keeps its start order so rows do not jump; settled work puts the latest first,
// so the overflow hides the oldest.
const byStatus = (left: Child, right: Child): number =>
  STATUS_ORDER[left.status] - STATUS_ORDER[right.status] ||
  (isActive(left)
    ? left.startedAt - right.startedAt
    : (right.completedAt ?? right.startedAt) - (left.completedAt ?? left.startedAt))

// Roots by status, each followed by its own leaves by status. A group with a running leaf ranks
// by its most active member, so a settled coordinator never hides live work below finished rows.
export function ordered(children: readonly Child[]): { readonly child: Child; readonly leaf: boolean; readonly live: boolean }[] {
  const ids = new Set(children.map(child => child.id))
  const isRoot = (child: Child) => child.parent === undefined || !ids.has(child.parent)
  const leavesOf = (root: Child) => children.filter(child => !isRoot(child) && child.parent === root.id)
  const rank = (root: Child) => Math.min(...[root, ...leavesOf(root)].map(child => STATUS_ORDER[child.status]))
  return children
    .filter(isRoot)
    .toSorted((left, right) => rank(left) - rank(right) || byStatus(left, right))
    .flatMap(root => {
      const live = rank(root) <= STATUS_ORDER.waiting
      return [
        { child: root, leaf: false, live },
        ...leavesOf(root)
          .toSorted(byStatus)
          .map(child => ({ child, leaf: true, live })),
      ]
    })
}

const elapsed = (child: Child, now: number): number => (child.completedAt ?? now) - child.startedAt

function rightColumn(theme: Theme, child: Child, narrow: boolean, now: number): string {
  const parts: string[] = []
  if (!narrow && child.model !== undefined) parts.push(theme.fg('muted', shortModel(child.model)))
  parts.push(theme.fg('muted', `↻ ${child.turns}`))
  const percent = child.context?.percent
  if (!narrow && typeof percent === 'number') {
    const color = child.status === 'running' ? contextColor(percent) : undefined
    parts.push(theme.fg(color ?? 'muted', `${Math.round(percent)}%`))
  }
  parts.push(theme.fg('muted', duration(elapsed(child, now))))
  return parts.join(theme.fg('dim', ' · '))
}

const pad = (text: string, columns: number): string => text + ' '.repeat(Math.max(0, columns - visibleWidth(text)))

// A running tool reads like a tool call in the transcript: its name, then its target.
function paintActivity(theme: Theme, activity: Activity): (text: string) => string {
  switch (activity.kind) {
    case 'tool': {
      const { name } = activity
      return text =>
        text.startsWith(name) ? theme.fg('toolTitle', name) + theme.fg('muted', text.slice(name.length)) : theme.fg('toolTitle', text)
    }
    case 'thinking':
    case 'writing':
      return text => theme.italic(theme.fg('thinkingText', text))
    case 'retrying':
      return text => theme.fg('muted', text)
  }
}

function activityOf(theme: Theme, child: Child): { readonly text: string; readonly paint: (text: string) => string } | undefined {
  if (child.status === 'running' && child.activity !== undefined)
    return { text: activityLabel(child.activity), paint: paintActivity(theme, child.activity) }
  if (child.status === 'failed' && child.error !== undefined)
    return { text: child.error.replace(/\s+/g, ' ').trim(), paint: text => theme.fg('error', text) }
  return undefined
}

interface Columns {
  readonly lead: number
  readonly task: number
}

function childRow(theme: Theme, row: { readonly child: Child; readonly leaf: boolean }, columns: Columns, width: number, now: number, frame: number): string {
  const { child, leaf } = row
  const narrow = width < NARROW
  const lead = pad(
    `${leaf ? theme.fg('dim', LEAF) : ''}${glyph(theme, child.status, frame)}  ${theme.bold(theme.fg(isActive(child) ? 'accent' : 'muted', title(child)))}`,
    columns.lead,
  )
  const right = rightColumn(theme, child, narrow, now)
  // Cells left for the task and the activity, each preceded by its gap.
  const room = width - visibleWidth(right) - 2 - visibleWidth(lead)
  const task = taskText(child.taskId)
  const activity = activityOf(theme, child)
  const activityNeed = activity === undefined ? 0 : 3 + Math.min(ACTIVITY_RESERVE, visibleWidth(activity.text))
  // The task keeps its column while the activity has its reserve; past that the task is
  // cut first, down to a readable minimum, and the activity takes whatever is left.
  let taskColumns = Math.min(columns.task, visibleWidth(task))
  if (2 + taskColumns + activityNeed > room) taskColumns = Math.max(0, room - 2 - activityNeed)
  if (taskColumns < MIN_TASK) taskColumns = Math.min(visibleWidth(task), MIN_TASK, Math.max(0, room - 2))
  const aligned = activity !== undefined && 2 + columns.task + activityNeed <= room ? columns.task : taskColumns
  let left = lead
  let used = 0
  if (taskColumns > 0) {
    left += `  ${theme.fg('muted', pad(truncateToWidth(task, taskColumns, '…'), aligned))}`
    used = 2 + Math.max(aligned, taskColumns)
  }
  const activityRoom = room - used - 3
  if (activity !== undefined && activityRoom >= Math.min(MIN_ACTIVITY, visibleWidth(activity.text)))
    left += `   ${activity.paint(truncateToWidth(activity.text, activityRoom, '…'))}`
  const gap = Math.max(2, width - visibleWidth(left) - visibleWidth(right))
  return truncateToWidth(left + ' '.repeat(gap) + right, width, '…')
}

function overflowRow(theme: Theme, hidden: readonly Child[]): string {
  const counts = new Map<Status, number>()
  for (const child of hidden) counts.set(child.status, (counts.get(child.status) ?? 0) + 1)
  const words = [...counts]
    .toSorted(([left], [right]) => STATUS_ORDER[left] - STATUS_ORDER[right])
    .map(([status, count]) => `${count} ${STATUS_WORDS[status]}`)
  return theme.bold(theme.fg('muted', `+${hidden.length}`)) + theme.fg('dim', `  ${words.join(' · ')}`)
}

const notice = (theme: Theme, text: string): string => theme.fg('warning', `${theme.bold('!')}  ${text}`)

// A quiet command has printed nothing for a while; dev reports it so the user can check on it.
function commandsRow(theme: Theme, commands: WorkView['commands']): string {
  const { running, quiet } = commands
  const row = theme.fg('muted', `${running} ${running === 1 ? 'command' : 'commands'} running`)
  if (quiet.length === 0) return row
  const silent = quiet.map(command => taskText(command.taskId)).join(', ')
  return row + theme.fg('dim', ' · ') + theme.fg('warning', `quiet: ${silent}`)
}

export function listRows(theme: Theme, view: WorkView | undefined, width: number, now: number, frame = 0): string[] {
  if (view === undefined || width <= 0) return []
  const rows = ordered(view.children)
  const shown = rows.slice(0, LIST_ROWS)
  const hidden = rows.slice(LIST_ROWS).map(row => row.child)
  const columns: Columns = {
    lead: Math.max(0, ...shown.map(({ child, leaf }) => (leaf ? visibleWidth(LEAF) : 0) + 3 + visibleWidth(title(child)))),
    task: Math.min(
      width < NARROW ? TASK_COLUMNS.narrow : TASK_COLUMNS.wide,
      Math.max(0, ...shown.map(({ child }) => visibleWidth(taskText(child.taskId)))),
    ),
  }
  const lines = shown.map(row => childRow(theme, row, columns, width, now, frame))
  const commands = view.commands.running
  // Running commands close the live rows, above the settled ones and the overflow.
  if (commands > 0)
    lines.splice(
      shown.findIndex(row => !row.live) === -1 ? shown.length : shown.findIndex(row => !row.live),
      0,
      commandsRow(theme, view.commands),
    )
  if (hidden.length > 0) lines.push(overflowRow(theme, hidden))
  if (view.blocks.agentsBlocked) lines.push(notice(theme, 'subscription exhausted: new agents blocked'))
  if (view.blocks.reactivationSuspended) lines.push(notice(theme, 'lead failed: automatic reactivation suspended'))
  return lines.map(line => truncateToWidth(line, width, '…'))
}

export const animates = (view: WorkView | undefined): boolean =>
  view !== undefined && view.children.some(isActive)
