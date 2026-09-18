import { pushTagFor } from '../src/lib/market.ts'
import { ruleNotifyEnabled } from '../src/lib/notifications.ts'
import { evaluateAlerts, extractMarketEvents, settingsForAlert } from '../src/lib/rules.ts'
import { alertNotificationCopy, withMatchTallies } from '../src/lib/tally.ts'
import type {
  AlertSettings,
  CornersByHalf,
  FeedAlert,
  Fixture,
  GoalEvent,
  Market,
  MomentumPayload,
} from '../src/lib/types.ts'
import {
  POLLER_ENABLED,
  POLLER_INTERVAL_MS,
  POLLER_REGION,
} from './config.ts'
import { currentSettings, ingestFeedAlerts, labelMatch } from './learn.ts'
import { sendPushToAll, type PushSendResult } from './push.ts'
import {
  fetchFixturesServer,
  fetchMomentumServer,
  isRoutineJsonError,
  lisbonDate,
  UpstreamJsonError,
} from './ss.ts'
import {
  isPrimed,
  loadActiveMarket,
  loadSent,
  markAlertPushed,
  markSent,
  primedKey,
  primeFixture,
  saveMatch,
  sentKey,
} from './store.ts'
import {
  attachOddsToAlerts,
  createTipFromAlert,
  resolvedOddFromAlert,
  settleTipsForMatch,
  tipAlreadyOpen,
} from './tips.ts'
import { warmupSokkerProBoard } from './sokkerpro.ts'
import type { PollerStatus } from './types.ts'

const status: PollerStatus = {
  enabled: POLLER_ENABLED,
  region: POLLER_REGION,
  intervalMs: POLLER_INTERVAL_MS,
  lastTickAt: null,
  lastError: null,
  liveWatched: 0,
  alertsSent: 0,
}

let inFlight = false

type SendPushFn = typeof sendPushToAll
let sendPush: SendPushFn = sendPushToAll
const pendingOddsAttach = new Set<Promise<void>>()

export function getPollerStatus(): PollerStatus {
  return { ...status }
}

export function setPollerSendPushForTests(fn: SendPushFn | null): void {
  sendPush = fn ?? sendPushToAll
}

export async function waitForOddsAttachForTests(): Promise<void> {
  while (pendingOddsAttach.size) {
    await Promise.all([...pendingOddsAttach])
  }
}

export type FixtureTickError = {
  fixtureId: string
  matchLabel: string
  message: string
  routineJson: boolean
  url?: string
}

/** Truncated/invalid JSON on a subset of fixtures is logged, not sticky lastError. */
export function lastErrorAfterFixtureFailures(
  errors: FixtureTickError[],
  targetCount: number,
): string | null {
  if (!errors.length) return null
  const allFailed = targetCount > 0 && errors.length >= targetCount
  const serious = errors.filter((e) => !e.routineJson)
  if (!serious.length && !allFailed) return null
  const shown = (serious.length ? serious : errors)[0]
  if (allFailed) return shown.message
  return `${serious.length}/${targetCount} jogos: ${shown.message}`
}

function cornersBundle(): CornersByHalf {
  return {
    ht: currentSettings('corners', 'ht'),
    ft: currentSettings('corners', 'ft'),
  }
}

function scheduleOddsAttach(work: () => Promise<void>): void {
  const run = work()
    .catch((err) => {
      console.warn(
        '[poller] odds attach',
        err instanceof Error ? err.message : err,
      )
    })
    .finally(() => {
      pendingOddsAttach.delete(run)
    })
  pendingOddsAttach.add(run)
}

async function notifyFreshAlerts(
  fixture: Fixture,
  market: ReturnType<typeof loadActiveMarket>,
  settings: ReturnType<typeof currentSettings>,
  byHalf: CornersByHalf | undefined,
  fresh: FeedAlert[],
): Promise<{ sent: number; notified: FeedAlert[] }> {
  let sent = 0
  const notified: FeedAlert[] = []
  for (const alert of fresh) {
    if (alert.coincident) continue
    const notify = settingsForAlert(alert, settings, byHalf)
    if (!ruleNotifyEnabled(notify, alert.rule)) continue
    const key = sentKey(market, fixture.id, alert.id, alert.cornerHalf)
    if (loadSent().includes(key)) continue
    if (!markSent(key)) continue
    notified.push(alert)
    const copy = alertNotificationCopy(alert)
    const alertKey = `${fixture.id}:${alert.id}`
    const result: PushSendResult = await sendPush({
      title: copy.title,
      body: copy.body,
      url: `/#/monitor?alert=${encodeURIComponent(alertKey)}`,
      alertKey,
      tag: pushTagFor(market, key),
    })
    if (result.sent > 0) {
      markAlertPushed(alertKey, market, alert.cornerHalf)
      sent += 1
    } else {
      console.error(
        '[poller] push não enviado',
        alertKey,
        result.errors.join(' | ') || 'sem detalhe',
      )
    }
  }
  return { sent, notified }
}

async function attachOddsAndEnrich(args: {
  fixture: Fixture
  market: Market
  settings: AlertSettings
  alerts: FeedAlert[]
  tipAlerts: FeedAlert[]
  ingest: boolean
}): Promise<void> {
  const withOdds = await attachOddsToAlerts({
    fixture: args.fixture,
    market: args.market,
    alerts: args.alerts,
  })
  if (args.ingest) {
    ingestFeedAlerts(withOdds, args.settings, false, args.market)
  }
  if (!args.tipAlerts.length) return
  const byId = new Map(withOdds.map((alert) => [alert.id, alert]))
  for (const alert of args.tipAlerts) {
    const enriched = byId.get(alert.id) ?? alert
    const odd = resolvedOddFromAlert(enriched)
    if (odd && !tipAlreadyOpen(args.fixture.id, alert.id)) {
      createTipFromAlert({ fixture: args.fixture, alert: enriched, odd })
    }
  }
}

export type EvaluatedAlertsTick = {
  fixture: Fixture
  market: Market
  settings: AlertSettings
  byHalf: CornersByHalf | undefined
  fresh: FeedAlert[]
  first: boolean
  finished: boolean
  payload: MomentumPayload
  events: GoalEvent[]
  points: { period: number; min: number }[]
}

/**
 * Evaluate/ingest/push on the critical path; SuperScore ∥ SokkerPro ∥ RoboBet
 * run afterwards. Do not await odds HTTP before notify.
 */
export async function processEvaluatedAlerts(
  args: EvaluatedAlertsTick,
): Promise<number> {
  const {
    fixture,
    market,
    settings,
    byHalf,
    fresh,
    first,
    finished,
    payload,
    events,
    points,
  } = args

  if (first) {
    for (const alert of fresh) {
      markSent(sentKey(market, fixture.id, alert.id, alert.cornerHalf))
    }
    if (finished) {
      ingestFeedAlerts(fresh, settings, false, market)
      labelMatch(
        {
          fixture,
          payload,
          finished,
          updatedAt: new Date().toISOString(),
        },
        undefined,
        market,
      )
    }
    const clock = points.at(-1)
    settleTipsForMatch({
      fixture,
      events,
      points,
      market,
      finished,
      clockMin: clock?.min,
      clockPeriod: clock?.period,
    })
    if (fresh.length) {
      scheduleOddsAttach(() =>
        attachOddsAndEnrich({
          fixture,
          market,
          settings,
          alerts: fresh,
          tipAlerts: [],
          ingest: finished,
        }),
      )
    }
    return 0
  }

  ingestFeedAlerts(fresh, settings, false, market)
  if (finished) {
    labelMatch(
      {
        fixture,
        payload,
        finished,
        updatedAt: new Date().toISOString(),
      },
      undefined,
      market,
    )
  }

  const clock = points.at(-1)
  settleTipsForMatch({
    fixture,
    events,
    points,
    market,
    finished,
    clockMin: clock?.min,
    clockPeriod: clock?.period,
  })

  // 1) notify / mark sent / ingest (already done)  2) void odds attach — never await before push
  const { sent, notified } = await notifyFreshAlerts(
    fixture,
    market,
    settings,
    byHalf,
    fresh,
  )
  if (fresh.length) {
    scheduleOddsAttach(() =>
      attachOddsAndEnrich({
        fixture,
        market,
        settings,
        alerts: fresh,
        tipAlerts: notified,
        ingest: true,
      }),
    )
  }
  return sent
}

async function processFixture(fixture: Fixture): Promise<number> {
  const payload = await fetchMomentumServer(fixture.id)
  const finished = fixture.state === 2 || fixture.status >= 100
  saveMatch({
    fixture,
    payload,
    finished,
    updatedAt: new Date().toISOString(),
  })

  const market = loadActiveMarket()
  const settings = currentSettings(market)
  const byHalf = market === 'corners' ? cornersBundle() : undefined
  const { points, alerts } = evaluateAlerts(payload, settings, undefined, byHalf)
  const events = extractMarketEvents(
    payload,
    points,
    market,
    market === 'corners' ? undefined : settings.cornerHalf,
  )
  const eventKeys = new Set(events.map((g) => `${g.period}-${g.min}-${g.index}`))
  const primedId = primedKey(market, fixture.id)
  const first = !isPrimed(primedId)
  if (first) primeFixture(primedId)

  const fresh: FeedAlert[] = alerts.map((alert) =>
    withMatchTallies(
      {
        ...alert,
        fixtureId: fixture.id,
        matchLabel: `${fixture.team1} vs ${fixture.team2}`,
        firedAt: new Date().toISOString(),
        coincident: eventKeys.has(`${alert.period}-${alert.min}-${alert.index}`),
        market,
      },
      payload,
    ),
  )

  return processEvaluatedAlerts({
    fixture,
    market,
    settings,
    byHalf,
    fresh,
    first,
    finished,
    payload,
    events,
    points,
  })
}

export async function tick(): Promise<void> {
  if (!POLLER_ENABLED) return
  if (inFlight) return
  inFlight = true
  try {
    const fixtures = await fetchFixturesServer(lisbonDate(), POLLER_REGION)
    const live = fixtures.filter((f) => f.state === 1)
    const recentDone = fixtures
      .filter((f) => f.state === 2 || f.status >= 100)
      .slice(0, 6)
    const targets = [...live.slice(0, 8), ...recentDone]
    status.liveWatched = live.length
    // Prefetch SokkerPro mini in parallel; do not block evaluate/push on board/preodds HTTP.
    void warmupSokkerProBoard()
    let sent = 0
    const tickErrors: FixtureTickError[] = []
    for (const fixture of targets) {
      try {
        sent += await processFixture(fixture)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Falha num jogo'
        const url = err instanceof UpstreamJsonError ? err.url : undefined
        console.error(
          '[poller] jogo falhou',
          fixture.id,
          `${fixture.team1} vs ${fixture.team2}`,
          url ?? '',
          message,
        )
        tickErrors.push({
          fixtureId: fixture.id,
          matchLabel: `${fixture.team1} vs ${fixture.team2}`,
          message,
          routineJson: isRoutineJsonError(err),
          url,
        })
      }
    }
    status.alertsSent += sent
    status.lastTickAt = new Date().toISOString()
    status.lastError = lastErrorAfterFixtureFailures(tickErrors, targets.length)
  } catch (err) {
    status.lastError = err instanceof Error ? err.message : 'Tick falhou'
    status.lastTickAt = new Date().toISOString()
  } finally {
    inFlight = false
  }
}

export function startPoller(): void {
  if (!POLLER_ENABLED) return
  void tick()
  setInterval(() => {
    void tick()
  }, POLLER_INTERVAL_MS)
}
