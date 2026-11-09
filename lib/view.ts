// The `dev/work-view` payload dev publishes (dev's docs/work.md, "Live view"). Each event is
// the complete view of one session; anything that does not have this shape is ignored.
import { oneLine, plainDeep, type Status } from './header.ts'

export const WORK_VIEW_EVENT = 'dev/work-view'

export type Activity =
  | { readonly kind: 'tool'; readonly name: string; readonly target?: string }
  | { readonly kind: 'thinking' }
  | { readonly kind: 'writing' }
  | { readonly kind: 'retrying'; readonly message: string }

export interface Child {
  readonly id: string
  readonly taskId: string
  readonly parent?: string
  readonly status: Status
  readonly skill?: string
  readonly coordinator: boolean
  readonly access?: string
  readonly model?: string
  readonly context?: { readonly percent: number | null }
  readonly startedAt: number
  readonly completedAt?: number
  readonly turns: number
  readonly activity?: Activity
  readonly error?: string
}

export interface WorkView {
  readonly sessionId: string
  readonly children: readonly Child[]
  readonly commands: { readonly running: number }
  readonly blocks: { readonly agentsBlocked: boolean; readonly reactivationSuspended: boolean }
}

const STATUSES = new Set(['running', 'waiting', 'completed', 'failed', 'cancelled', 'unknown'])

type Fields = Record<string, unknown>
const isObject = (value: unknown): value is Fields =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const optional = (value: unknown, type: string): boolean => value === undefined || typeof value === type
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

const isActivity = (value: unknown): value is Activity => {
  if (!isObject(value)) return false
  switch (value.kind) {
    case 'tool':
      return typeof value.name === 'string' && optional(value.target, 'string')
    case 'thinking':
    case 'writing':
      return true
    case 'retrying':
      return typeof value.message === 'string'
    default:
      return false
  }
}

const isChild = (value: unknown): value is Child =>
  isObject(value) &&
  typeof value.id === 'string' &&
  typeof value.taskId === 'string' &&
  optional(value.parent, 'string') &&
  typeof value.status === 'string' &&
  STATUSES.has(value.status) &&
  optional(value.skill, 'string') &&
  typeof value.coordinator === 'boolean' &&
  optional(value.access, 'string') &&
  optional(value.model, 'string') &&
  (value.context === undefined ||
    (isObject(value.context) && (value.context.percent === null || finite(value.context.percent)))) &&
  finite(value.startedAt) &&
  (value.completedAt === undefined || finite(value.completedAt)) &&
  finite(value.turns) &&
  (value.activity === undefined || isActivity(value.activity)) &&
  optional(value.error, 'string')

export const asWorkView = (value: unknown): WorkView | undefined =>
  isObject(value) &&
  typeof value.sessionId === 'string' &&
  Array.isArray(value.children) &&
  value.children.every(isChild) &&
  isObject(value.commands) &&
  finite(value.commands.running) &&
  isObject(value.blocks) &&
  typeof value.blocks.agentsBlocked === 'boolean' &&
  typeof value.blocks.reactivationSuspended === 'boolean'
    ? (plainDeep(value, oneLine) as WorkView)
    : undefined

export const isActive = (child: Child): boolean => child.status === 'running' || child.status === 'waiting'
