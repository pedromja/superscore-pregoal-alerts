import { pushTagFor } from '../src/lib/market.ts'
import { ruleNotifyEnabled } from '../src/lib/notifications.ts'
import { evaluateAlerts, extractMarketEvents, settingsForAlert } from '../src/lib/rules.ts'
import { inMarketClockWindow } from '../src/lib/windows.ts'
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
  POLLER_CONCURRENCY,
  POLLER_ENABLED,
  POLLER_FINISHED_LIMIT,
  POLLER_FIXTURE_TIMEOUT_MS,
  POLLER_INTERVAL_MS,
  POLLER_JSON_BACKOFF_MAX_MS,
  POLLER_LIVE_LIMIT,
  POLLER_REGION,
  POLLER_TICK_WATCHDOG_MS,
  webPushEnabled,
} from './config.ts'
import { currentSettings, ingestFeedAlerts, labelMatch } from './learn.ts'
import {
  resetTelegramOutcomesForTests,
  scheduleTelegramOutcomeFlush,
} from './telegramOutcomes.ts'
import {
  JsonBackoff,
  TimeoutError,
  mapLimit,
  selectLiveTargets,
  withTimeout,
} from './pollerHealth.ts'
import { sendPushToAll, type PushSendResult } from './push.ts'
import {
  getTelegramStatus,
  sendTelegramAlert,
  type TelegramSendResult,
} from './telegram.ts'
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
  loadSubscriptions,
  markAlertPushed,
  markAlertTelegramMessage,
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
  tickInFlight: false,
  lastTickDurationMs: null,
  lastHangAt: null,
  lastFixtureError: null,
  liveProcessed: 0,
  pushSubscribers: 0,
  webPushEnabled: webPushEnabled(),
  telegram: getTelegramStatus(),
}

let inFlight = false
let tickGen = 0
let tickIndex = 0
let watchdogTimer: ReturnType<typeof setTimeout> | null = null
let tickAbort: AbortController | null = null
let fixtureTimeoutMs = POLLER_FIXTURE_TIMEOUT_MS
let tickWatchdogMs = POLLER_TICK_WATCHDOG_MS
let liveLimit = POLLER_LIVE_LIMIT
let finishedLimit = POLLER_FINISHED_LIMIT
let concurrency = POLLER_CONCURRENCY
const jsonBackoff = new JsonBackoff(POLLER_INTERVAL_MS, POLLER_JSON_BACKOFF_MAX_MS)
const lastMomentumOkAt = new Map<string, number>()
let storeTail = Promise.resolve()

type SendPushFn = typeof sendPushToAll
type SendTelegramFn = typeof sendTelegramAlert
let sendPush: SendPushFn = sendPushToAll
let sendTelegram: SendTelegramFn = sendTelegramAlert
const pendingOddsAttach = new Set<Promise<void>>()

type ProcessFixtureFn = (fixture: Fixture, signal?: AbortSignal) => Promise<number>
type FetchFixturesFn = (signal?: AbortSignal) => Promise<Fixture[]>
type WarmupFn = () => Promise<unknown>

let processFixtureFn: ProcessFixtureFn = processFixture
let fetchFixturesFn: FetchFixturesFn = defaultFetchFixtures
let warmupFn: WarmupFn = warmupSokkerProBoard

async function defaultFetchFixtures(signal?: AbortSignal): Promise<Fixture[]> {
  return fetchFixturesServer(lisbonDate(), POLLER_REGION, signal)
}

function withStoreLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const run = storeTail.then(fn, fn)
  storeTail = run.then(
    () => undefined,
    () => undefined,
  )
  return run
}

export function getPollerStatus(): PollerStatus {
  return {
    ...status,
    tickInFlight: inFlight,
    pushSubscribers: loadSubscriptions().length,
    webPushEnabled: webPushEnabled(),
    telegram: getTelegramStatus(),
  }
}

export function setPollerSendPushForTests(fn: SendPushFn | null): void {
  sendPush = fn ?? sendPushToAll
}

export function setPollerSendTelegramForTests(fn: SendTelegramFn | null): void {
  sendTelegram = fn ?? sendTelegramAlert
}

export async function waitForOddsAttachForTests(): Promise<void> {
  while (pendingOddsAttach.size) {
    await Promise.all([...pendingOddsAttach])
  }
}

export function setPollerDepsForTests(deps: {
  processFixture?: ProcessFixtureFn | null
  fetchFixtures?: FetchFixturesFn | null
  warmup?: WarmupFn | null
} | null): void {
  processFixtureFn = deps?.processFixture ?? processFixture
  fetchFixturesFn = deps?.fetchFixtures ?? defaultFetchFixtures
  warmupFn = deps?.warmup ?? warmupSokkerProBoard
}

export function setPollerLimitsForTests(
  opts: {
    fixtureTimeoutMs?: number
    tickWatchdogMs?: number
    liveLimit?: number
    finishedLimit?: number
    concurrency?: number
  } | null,
): void {
  fixtureTimeoutMs = opts?.fixtureTimeoutMs ?? POLLER_FIXTURE_TIMEOUT_MS
  tickWatchdogMs = opts?.tickWatchdogMs ?? POLLER_TICK_WATCHDOG_MS
  liveLimit = opts?.liveLimit ?? POLLER_LIVE_LIMIT
  finishedLimit = opts?.finishedLimit ?? POLLER_FINISHED_LIMIT
  concurrency = opts?.concurrency ?? POLLER_CONCURRENCY
}

export function resetPollerRuntimeForTests(): void {
  clearWatchdog()
  tickAbort?.abort()
  tickAbort = null
  inFlight = false
  tickGen += 1
  tickIndex = 0
  jsonBackoff.reset()
  lastMomentumOkAt.clear()
  storeTail = Promise.resolve()
  fixtureTimeoutMs = POLLER_FIXTURE_TIMEOUT_MS
  tickWatchdogMs = POLLER_TICK_WATCHDOG_MS
  liveLimit = POLLER_LIVE_LIMIT
  finishedLimit = POLLER_FINISHED_LIMIT
  concurrency = POLLER_CONCURRENCY
  processFixtureFn = processFixture
  fetchFixturesFn = defaultFetchFixtures
  warmupFn = warmupSokkerProBoard
  status.lastTickAt = null
  status.lastError = null
  status.liveWatched = 0
  status.alertsSent = 0
  status.tickInFlight = false
  status.lastTickDurationMs = null
  status.lastHangAt = null
  status.lastFixtureError = null
  status.liveProcessed = 0
  status.pushSubscribers = 0
  status.webPushEnabled = webPushEnabled()
  status.telegram = getTelegramStatus()
  sendTelegram = sendTelegramAlert
  resetTelegramOutcomesForTests()
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

function halvesBundle(market: ReturnType<typeof loadActiveMarket>) {
  return {
    ht: currentSettings(market, 'ht'),
    ft: currentSettings(market, 'ft'),
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
    // Stoppage (P1>45 / P2>90) and out-of-window: no push. Yeovil 96' arrived
    // after the goal; bookie markets were already gone.
    if (!inMarketClockWindow(market, alert.min, alert.period)) continue
    const notify = settingsForAlert(alert, settings, byHalf)
    if (!ruleNotifyEnabled(notify, alert.rule)) continue
    const key = sentKey(market, fixture.id, alert.id, alert.cornerHalf)
    if (loadSent().includes(key)) continue
    if (!markSent(key)) continue
    notified.push(alert)
    const copy = alertNotificationCopy(alert)
    const alertKey = `${fixture.id}:${alert.id}`
    const monitorUrl = `/#/monitor?alert=${encodeURIComponent(alertKey)}`
    let notifiedOk = false
    const telegramResult: TelegramSendResult = await sendTelegram({
      title: copy.title,
      body: copy.body,
      url: monitorUrl,
      alertKey,
      ruleLabel: alert.ruleName,
    })
    if (telegramResult.sent > 0) {
      notifiedOk = true
      if (telegramResult.messageId != null) {
        markAlertTelegramMessage(
          alertKey,
          telegramResult.messageId,
          market,
          alert.cornerHalf,
        )
      }
    } else if (!telegramResult.skipped) {
      console.error(
        '[poller] telegram não enviado',
        alertKey,
        telegramResult.reason || 'sem detalhe',
      )
    }
    if (webPushEnabled()) {
      const result: PushSendResult = await sendPush({
        title: copy.title,
        body: copy.body,
        url: monitorUrl,
        alertKey,
        tag: pushTagFor(market, key),
      })
      if (result.sent > 0) {
        notifiedOk = true
      } else if (!result.errors.includes('sem subscritores')) {
        console.error(
          '[poller] push não enviado',
          alertKey,
          result.errors.join(' | ') || 'sem detalhe',
        )
      }
    }
    if (notifiedOk) {
      markAlertPushed(alertKey, market, alert.cornerHalf)
      sent += 1
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
 * Evaluate/ingest/telegram on the critical path; SuperScore ∥ SokkerPro ∥ RoboBet
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
    first,
    finished,
    payload,
    events,
    points,
  } = args
  const fresh = args.fresh.filter((alert) =>
    inMarketClockWindow(market, alert.min, alert.period),
  )

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
        undefined,
        { flushTelegramOutcomes: false },
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
    scheduleTelegramOutcomeFlush()
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
      undefined,
      { flushTelegramOutcomes: false },
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

  // 1) notify / mark sent / ingest (already done)  2) void odds attach — never await before telegram
  const { sent, notified } = await notifyFreshAlerts(
    fixture,
    market,
    settings,
    byHalf,
    fresh,
  )
  scheduleTelegramOutcomeFlush()
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

async function processFixture(fixture: Fixture, signal?: AbortSignal): Promise<number> {
  const payload = await fetchMomentumServer(fixture.id, signal)
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('abortado')
  }
  lastMomentumOkAt.set(fixture.id, Date.now())
  jsonBackoff.noteSuccess(fixture.id)
  const finished = fixture.state === 2 || fixture.status >= 100
  return withStoreLock(async () => {
    saveMatch({
      fixture,
      payload,
      finished,
      updatedAt: new Date().toISOString(),
    })

    const market = loadActiveMarket()
    const settings = currentSettings(market)
    const byHalf = halvesBundle(market)
    const { points, alerts: rawAlerts } = evaluateAlerts(
      payload,
      settings,
      undefined,
      byHalf,
    )
    const alerts = rawAlerts.filter((alert) =>
      inMarketClockWindow(market, alert.min, alert.period),
    )
    const events = extractMarketEvents(payload, points, market)
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
  })
}

function clearWatchdog(): void {
  if (watchdogTimer) {
    clearTimeout(watchdogTimer)
    watchdogTimer = null
  }
}

function releaseHungTick(gen: number, reason: string): void {
  if (tickGen !== gen || !inFlight) return
  console.error('[poller] tick hung — a libertar inFlight:', reason)
  status.lastHangAt = new Date().toISOString()
  status.lastError = reason
  inFlight = false
  status.tickInFlight = false
  tickAbort?.abort()
  tickGen += 1
}

function armWatchdog(gen: number): void {
  clearWatchdog()
  watchdogTimer = setTimeout(() => {
    releaseHungTick(gen, `Tick hung ${tickWatchdogMs}ms`)
  }, tickWatchdogMs)
}

function recordFixtureError(fixture: Fixture, message: string): void {
  status.lastFixtureError = {
    fixtureId: fixture.id,
    matchLabel: `${fixture.team1} vs ${fixture.team2}`,
    message,
    at: new Date().toISOString(),
  }
}

async function processFixtureTimed(
  fixture: Fixture,
  parentSignal?: AbortSignal,
): Promise<number> {
  const ctrl = new AbortController()
  const onParentAbort = () => ctrl.abort()
  parentSignal?.addEventListener('abort', onParentAbort, { once: true })
  if (parentSignal?.aborted) ctrl.abort()
  const work = processFixtureFn(fixture, ctrl.signal)
  try {
    return await withTimeout(
      work,
      fixtureTimeoutMs,
      `Timeout ${fixtureTimeoutMs}ms (jogo ${fixture.id})`,
    )
  } catch (err) {
    ctrl.abort()
    void work.catch(() => undefined)
    throw err
  } finally {
    parentSignal?.removeEventListener('abort', onParentAbort)
  }
}

export async function tick(): Promise<void> {
  if (!POLLER_ENABLED) return
  if (inFlight) return
  const gen = ++tickGen
  inFlight = true
  status.tickInFlight = true
  const started = Date.now()
  tickAbort = new AbortController()
  const signal = tickAbort.signal
  armWatchdog(gen)
  try {
    const fetchWork = fetchFixturesFn(signal)
    let fixtures: Fixture[]
    try {
      fixtures = await withTimeout(
        fetchWork,
        Math.max(fixtureTimeoutMs, 8_000),
        'Timeout a obter jogos',
      )
    } catch (err) {
      tickAbort.abort()
      void fetchWork.catch(() => undefined)
      throw err
    }

    const now = Date.now()
    const live = fixtures.filter((f) => f.state === 1)
    jsonBackoff.prune(new Set(fixtures.map((f) => f.id)))
    const liveTargets = selectLiveTargets({
      live,
      market: loadActiveMarket(),
      limit: liveLimit,
      now,
      tickIndex,
      lastOkAt: lastMomentumOkAt,
      isBackedOff: (id) => jsonBackoff.isBlocked(id, now),
    })
    const recentDone = fixtures
      .filter((f) => f.state === 2 || f.status >= 100)
      .filter((f) => !jsonBackoff.isBlocked(f.id, now))
      .slice(0, finishedLimit)
    const targets = [...liveTargets, ...recentDone]
    tickIndex += 1
    status.liveWatched = live.length
    status.liveProcessed = 0
    status.pushSubscribers = loadSubscriptions().length
    status.webPushEnabled = webPushEnabled()
    status.telegram = getTelegramStatus()
    if (webPushEnabled() && status.pushSubscribers === 0) {
      console.warn(
        '[poller] Web Push: 0 subscritores neste tick — os alertas não chegam ao telemóvel (ativar notificações remotas na PWA)',
      )
    }
    // Prefetch SokkerPro mini in parallel; do not block evaluate/push on board/preodds HTTP.
    void warmupFn()
    const tickErrors: FixtureTickError[] = []
    const sentParts = await mapLimit(
      targets,
      concurrency,
      async (fixture) => {
        if (signal.aborted) return 0
        try {
          const n = await processFixtureTimed(fixture, signal)
          status.liveProcessed += 1
          return n
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
          if (isRoutineJsonError(err)) jsonBackoff.noteFailure(fixture.id, Date.now())
          recordFixtureError(fixture, message)
          tickErrors.push({
            fixtureId: fixture.id,
            matchLabel: `${fixture.team1} vs ${fixture.team2}`,
            message,
            routineJson: isRoutineJsonError(err),
            url,
          })
          status.liveProcessed += 1
          return 0
        }
      },
    )
    if (tickGen !== gen) return
    const sent = sentParts.reduce((sum, n) => sum + n, 0)
    status.alertsSent += sent
    status.lastTickAt = new Date().toISOString()
    status.lastError = lastErrorAfterFixtureFailures(tickErrors, targets.length)
  } catch (err) {
    if (tickGen !== gen) return
    status.lastError = err instanceof Error ? err.message : 'Tick falhou'
    status.lastTickAt = new Date().toISOString()
    if (err instanceof TimeoutError) {
      status.lastHangAt = status.lastTickAt
    }
  } finally {
    clearWatchdog()
    if (tickGen === gen) {
      inFlight = false
      status.tickInFlight = false
      status.lastTickDurationMs = Date.now() - started
      tickAbort = null
    }
  }
}

export function startPoller(): void {
  if (!POLLER_ENABLED) return
  void tick()
  setInterval(() => {
    void tick()
  }, POLLER_INTERVAL_MS)
}
