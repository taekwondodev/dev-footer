import type { SessionEntry } from '@earendil-works/pi-coding-agent'

export const CACHE_WINDOW_MS = 5 * 60 * 1000
export const SPARK_RUNS = 8

export interface SessionStats {
  readonly cost: number
  readonly cacheHit?: number
  readonly runs: readonly number[]
  readonly lastRequestAt?: number
}

const entryCost = (entry: SessionEntry): number => {
  switch (entry.type) {
    case 'message':
      return entry.message.role === 'assistant' || entry.message.role === 'toolResult'
        ? (entry.message.usage?.cost.total ?? 0)
        : 0
    case 'usage':
      return entry.usage.cost.total
    case 'compaction':
    case 'branch_summary':
      return entry.usage?.cost.total ?? 0
    default:
      return 0
  }
}

// Cost covers every entry, like Pi's footer; the rest follows the active branch.
export function sessionStats(entries: readonly SessionEntry[], branch: readonly SessionEntry[]): SessionStats {
  let cost = 0
  for (const entry of entries) cost += entryCost(entry)

  let cacheHit: number | undefined
  let lastRequestAt: number | undefined
  const runs: number[] = []
  let inRun = false
  for (const entry of branch) {
    if (entry.type === 'usage') lastRequestAt = Date.parse(entry.timestamp)
    if (entry.type !== 'message') continue
    const { message } = entry
    if (message.role === 'user') inRun = false
    if (message.role !== 'assistant') continue
    lastRequestAt = Date.parse(entry.timestamp)
    const prompt = message.usage.input + message.usage.cacheRead + message.usage.cacheWrite
    cacheHit = prompt > 0 ? (message.usage.cacheRead / prompt) * 100 : cacheHit
    if (!inRun) runs.push(0)
    inRun = true
    runs[runs.length - 1]! += message.usage.totalTokens
  }
  return {
    cost,
    ...(cacheHit === undefined ? {} : { cacheHit }),
    runs: runs.filter(tokens => tokens > 0).slice(-SPARK_RUNS),
    ...(lastRequestAt === undefined || Number.isNaN(lastRequestAt) ? {} : { lastRequestAt }),
  }
}

export function cacheRemaining(lastRequestAt: number | undefined, now: number): number | undefined {
  return lastRequestAt === undefined ? undefined : CACHE_WINDOW_MS - (now - lastRequestAt)
}
