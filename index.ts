// dev-footer: everything below the editor and the transcript rows for dev's background
// work. The subagent list is a below-editor widget fed by dev's `dev/work-view` event; the
// HUD replaces Pi's footer; the `work` and `dev/work-outcome` renderers read `details`.
// EXPECTED-BEHAVIOR.md states the contract; check.mjs verifies it.
//
// Pi renders on every frame, so render() does no I/O: the list draws the latest view,
// the HUD draws repository facts read in the background after each turn (one read at a
// time, gh at most once a minute per branch), and the renderers draw `details` and the
// cached session reads. Nothing runs while idle except the list's spinner while a child
// is active and the cache clock while it counts down.
import { basename } from 'node:path'
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent'
import { getCapabilities, type TUI } from '@earendil-works/pi-tui'
import { SPINNER, SPINNER_INTERVAL_MS } from './lib/header.ts'
import { type CacheClock, hudRows } from './lib/hud.ts'
import { animates, listRows } from './lib/list.ts'
import { type PullRequest, readPullRequest, readRepoFacts, type RepoFacts } from './lib/repo.ts'
import { outcomeRenderer, workRenderers } from './lib/rows.ts'
import { onSessionRead } from './lib/session.ts'
import { cacheRemaining, type SessionStats, sessionStats } from './lib/stats.ts'
import { asWorkView, WORK_VIEW_EVENT, type WorkView } from './lib/view.ts'

export const LIST_WIDGET = 'dev-footer/subagents'
const PULL_REQUEST_TTL_MS = 60_000

const sameFacts = (a: RepoFacts, b: RepoFacts): boolean =>
  a.url === b.url &&
  a.defaultBranch === b.defaultBranch &&
  a.worktrees === b.worktrees &&
  a.diff?.added === b.diff?.added &&
  a.diff?.removed === b.diff?.removed

interface PullRequestLookup {
  readonly cwd: string
  readonly branch: string
  readonly checkedAt: number
  readonly value?: PullRequest
}

export default function (pi: ExtensionAPI): void {
  let enabled = true
  let active: ExtensionContext | undefined
  let sessionId: string | undefined
  let respondedAt: number | undefined
  let repo: RepoFacts = { worktrees: 0 }
  let reading = false
  let stale = false
  let pullRequest: PullRequestLookup | undefined
  let lookingUp = false
  let currentBranch: () => string | null = () => null
  let requestFooterRender: (() => void) | undefined
  let requestListRender: (() => void) | undefined
  let statsKey = ''
  let stats: SessionStats = { cost: 0, runs: [] }
  let contextUsage: ReturnType<ExtensionContext['getContextUsage']>
  let view: WorkView | undefined
  let ticker: NodeJS.Timeout | undefined

  const stopTicker = (): void => {
    if (ticker !== undefined) clearInterval(ticker)
    ticker = undefined
  }

  // The spinner and durations move only while a child is active.
  const syncTicker = (): void => {
    if (!animates(view) || requestListRender === undefined) return stopTicker()
    if (ticker !== undefined) return
    ticker = setInterval(() => requestListRender?.(), SPINNER_INTERVAL_MS)
    ticker.unref()
  }

  pi.events.on(WORK_VIEW_EVENT, payload => {
    const next = asWorkView(payload)
    if (next === undefined || next.sessionId !== sessionId) return
    view = next
    syncTicker()
    requestListRender?.()
  })

  onSessionRead(() => (requestListRender ?? requestFooterRender)?.())
  pi.registerToolRenderer((toolName, next) => (toolName === 'work' ? workRenderers() : next()))
  pi.registerMessageRenderer('dev/work-outcome', outcomeRenderer)

  // The default branch and detached heads have no pull request worth a network call.
  const refreshPullRequest = (cwd: string): void => {
    const branch = currentBranch()
    if (repo.url === undefined || branch === null || branch === 'detached' || branch === repo.defaultBranch) return
    const last = pullRequest
    if (lookingUp || (last?.cwd === cwd && last.branch === branch && Date.now() - last.checkedAt < PULL_REQUEST_TTL_MS)) return
    lookingUp = true
    void readPullRequest(cwd, branch).then(value => {
      lookingUp = false
      pullRequest = { cwd, branch, checkedAt: Date.now(), ...(value === undefined ? {} : { value }) }
      if (value?.number !== last?.value?.number || value?.state !== last?.value?.state || branch !== last?.branch) requestFooterRender?.()
      // A checkout or session switch during the lookup asks again for the new branch.
      const now = active?.sessionManager.getCwd()
      if (now !== undefined && (now !== cwd || currentBranch() !== branch)) refreshPullRequest(now)
    })
  }

  // One read at a time: a request during a read reruns it once afterwards with the current session.
  const refreshRepo = (ctx: ExtensionContext): void => {
    if (!enabled) return
    if (reading) {
      stale = true
      return
    }
    reading = true
    const cwd = ctx.sessionManager.getCwd()
    void readRepoFacts(cwd).then(facts => {
      reading = false
      if (stale) {
        stale = false
        if (active !== undefined) refreshRepo(active)
        return
      }
      if (!sameFacts(facts, repo)) {
        repo = facts
        requestFooterRender?.()
      }
      refreshPullRequest(cwd)
    })
  }

  const currentStats = (ctx: ExtensionContext): SessionStats => {
    const { sessionManager } = ctx
    const key = `${sessionManager.getSessionId()}\0${sessionManager.getLeafId()}\0${ctx.model?.provider}/${ctx.model?.id}`
    if (key !== statsKey) {
      statsKey = key
      stats = sessionStats(sessionManager.getEntries(), sessionManager.getBranch())
      contextUsage = ctx.getContextUsage()
    }
    return stats
  }

  const installList = (ctx: ExtensionContext): void => {
    ctx.ui.setWidget(
      LIST_WIDGET,
      (tui: TUI, theme) => {
        requestListRender = () => tui.requestRender()
        syncTicker()
        return {
          invalidate() {},
          dispose() {
            stopTicker()
            requestListRender = undefined
          },
          render: (width: number): string[] => {
            const now = Date.now()
            return listRows(theme, view, width, now, Math.floor(now / SPINNER_INTERVAL_MS) % SPINNER.length)
          },
        }
      },
      { placement: 'belowEditor' },
    )
  }

  const installFooter = (ctx: ExtensionContext): void => {
    if (!enabled) {
      ctx.ui.setFooter(undefined)
      return
    }
    ctx.ui.setFooter((tui: TUI, _theme, footerData) => {
      let tick: NodeJS.Timeout | undefined
      let last: string[] = []
      requestFooterRender = () => tui.requestRender()
      currentBranch = () => footerData.getGitBranch()
      const unsubscribe = footerData.onBranchChange(() => {
        if (active !== undefined) refreshRepo(active)
        tui.requestRender()
      })
      const scheduleTick = (remainingMs: number): void => {
        if (tick !== undefined) return
        tick = setTimeout(() => {
          tick = undefined
          tui.requestRender()
        }, (remainingMs % 1000) + 1)
        tick.unref()
      }
      return {
        invalidate() {},
        dispose() {
          unsubscribe()
          if (tick !== undefined) clearTimeout(tick)
          requestFooterRender = undefined
          currentBranch = () => null
        },
        render(width: number): string[] {
          const ctx = active
          if (ctx === undefined) return last
          const { theme } = ctx.ui
          const current = currentStats(ctx)
          const lastRequestAt = Math.max(current.lastRequestAt ?? -Infinity, respondedAt ?? -Infinity)
          const remaining = cacheRemaining(Number.isFinite(lastRequestAt) ? lastRequestAt : undefined, Date.now())
          let clock: CacheClock
          if (remaining !== undefined && remaining > 0) {
            clock = { remainingMs: remaining }
            scheduleTick(remaining)
          } else if (remaining !== undefined) clock = 'cold'
          const cwd = ctx.sessionManager.getCwd()
          const branch = footerData.getGitBranch()
          const pr = pullRequest !== undefined && pullRequest.cwd === cwd && pullRequest.branch === branch ? pullRequest.value : undefined
          const session = ctx.sessionManager.getSessionName()
          const model = ctx.model
          last = hudRows(
            theme,
            {
              folder: basename(cwd),
              worktrees: repo.worktrees,
              ...(repo.url === undefined ? {} : { repoUrl: repo.url }),
              ...(branch === null ? {} : { branch }),
              ...(pr === undefined ? {} : { pullRequest: pr }),
              ...(repo.diff === undefined ? {} : { diff: repo.diff }),
              ...(session === undefined ? {} : { session }),
              ...(model === undefined ? {} : { model: model.id }),
              ...(model?.reasoning ? { thinking: pi.getThinkingLevel() } : {}),
            },
            {
              ...(contextUsage === undefined ? {} : { context: { percent: contextUsage.percent } }),
              cost: current.cost,
              ...(current.cacheHit === undefined ? {} : { cacheHit: current.cacheHit }),
              clock,
              runs: current.runs,
            },
            width,
            getCapabilities().hyperlinks,
          )
          return last
        },
      }
    })
  }

  pi.on('session_start', (_event, ctx) => {
    if (ctx.mode !== 'tui') return
    active = ctx
    respondedAt = undefined
    statsKey = ''
    const next = ctx.sessionManager.getSessionId()
    if (next !== sessionId) view = undefined
    sessionId = next
    installList(ctx)
    installFooter(ctx)
    refreshRepo(ctx)
  })
  // Pi invalidates ctx right after shutdown, but the TUI can still render before the
  // next session_start; the footer then repeats its last rows.
  pi.on('session_shutdown', () => {
    active = undefined
    stopTicker()
  })
  pi.on('after_provider_response', () => {
    respondedAt = Date.now()
  })
  pi.on('turn_end', (_event, ctx) => {
    if (active !== undefined) refreshRepo(ctx)
  })
  pi.on('agent_end', (_event, ctx) => {
    if (active !== undefined) refreshRepo(ctx)
  })

  pi.registerCommand('footer', {
    description: 'Toggle the HUD footer and Pi’s default footer',
    handler: async (_args, ctx) => {
      enabled = !enabled
      installFooter(ctx)
      refreshRepo(ctx)
      ctx.ui.notify(enabled ? 'HUD footer enabled' : 'Default footer restored', 'info')
    },
  })
}
