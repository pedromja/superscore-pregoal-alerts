import { pushTagFor } from '../src/lib/market.ts'
import { ruleNotifyEnabled } from '../src/lib/notifications.ts'
import { notifySuppressReason } from '../src/lib/notifyLead.ts'
import {
  evaluateAlerts,
  extractMarketEvents,
  normalizeTimeline,
  settingsForAlert,
} from '../src/lib/rules.ts'
import { inMarketClockWindow } from '../src/lib/windows.ts'
import { alertNotificationCopy, withMatchTallies } from '../src/lib/tally.ts'
import { QUALITY_FILTER_LINE, withCapReason } from '../src/lib/qualityOverlay.ts'
import type {
  AlertOverlay,
  AlertSettings,
  CornerHalf,
  CornersByHalf,
  FeedAlert,
  Fixture,
  GoalEvent,
  Market,
  MomentumPayload,
} from '../src/lib/types.ts'
import {
  MIN_NOTIFY_LEAD_MIN,
  POLLER_CONCURRENCY,
  POLLER_ENABLED,
  POLLER_FINISHED_LIMIT,
  POLLER_FIXTURE_TIMEOUT_MS,
  POLLER_INTERVAL_MS,
  POLLER_IN_WINDOW_CONCURRENCY,
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
  getTelegramMessage,
  isPrimed,
  loadAlerts,
  loadMatch,
  loadSent,
  loadSubscriptions,
  markAlertPushed,
  markAlertTelegramMessage,
  markSent,
  primedKey,
  primeFixture,
  saveAlerts,
  saveMatch,
  sentKey,
  telegramRecordMarket,
} from './store.ts'
import {
  resetTelegramRetryForTests,
  scheduleTelegramRetry,
  telegramRetryNow,
} from './telegramRetry.ts'
import {
  attachOddsToAlerts,
  createTipFromAlert,
  resolvedOddFromAlert,
  settleTipsForMatch,
  tipAlreadyOpen,
} from './tips.ts'
import { warmupSokkerProBoard } from './sokkerpro.ts'
import { alertKeyFor, loggedAlertId } from './alertKeys.ts'
import {
  alertHalf,
  annotateOverlay,
  overlayCapReached,
  overlayForFeedAlert,
  qualityOverlayEnabled,
} from './qualityOverlay.ts'
import type { LoggedAlert, PollerStatus } from './types.ts'

const status: PollerStatus = {
  enabled: POLLER_ENABLED,
  region: POLLER_REGION,
  intervalMs: POLLER_INTERVAL_MS,
  lastTickAt: null,
  lastError: null,
  liveWatched: 0,
  inWindowThisTick: 0,
  lastAlertLatencyHint: null,
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
let inWindowConcurrency = POLLER_IN_WINDOW_CONCURRENCY
const jsonBackoff = new JsonBackoff(POLLER_INTERVAL_MS, POLLER_JSON_BACKOFF_MAX_MS)
const lastMomentumOkAt = new Map<string, number>()
let storeTail = Promise.resolve()
let currentTickStarted = 0

type SendPushFn = typeof sendPushToAll
type SendTelegramFn = typeof sendTelegramAlert
let sendPush: SendPushFn = sendPushToAll
let sendTelegram: SendTelegramFn = sendTelegramAlert
const pendingOddsAttach = new Set<Promise<void>>()

type ProcessFixtureFn = (fixture: Fixture, signal?: AbortSignal) => Promise<number>
type FetchFixturesFn = (signal?: AbortSignal) => Promise<Fixture[]>
type WarmupFn = () => Promise<unknown>

type FetchMomentumFn = typeof fetchMomentumServer

/**
 * Both markets are evaluated, alerted, settled and learned on every tick, each
 * with its own locked definitions, windows, learning stores and dedupe keys.
 * `data/market.json` (UI Goals|Cantos toggle) is a view preference only.
 */
export const EVALUATED_MARKETS: readonly Market[] = ['goals', 'corners']

let processFixtureFn: ProcessFixtureFn = processFixture
let fetchFixturesFn: FetchFixturesFn = defaultFetchFixtures
let warmupFn: WarmupFn = warmupSokkerProBoard
let fetchMomentumFn: FetchMomentumFn = fetchMomentumServer

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

async function settleOddsAttach(): Promise<void> {
  while (pendingOddsAttach.size) {
    await Promise.all([...pendingOddsAttach])
  }
}

export async function waitForOddsAttachForTests(): Promise<void> {
  await settleOddsAttach()
}

export function setPollerDepsForTests(deps: {
  processFixture?: ProcessFixtureFn | null
  fetchFixtures?: FetchFixturesFn | null
  warmup?: WarmupFn | null
  fetchMomentum?: FetchMomentumFn | null
} | null): void {
  processFixtureFn = deps?.processFixture ?? processFixture
  fetchFixturesFn = deps?.fetchFixtures ?? defaultFetchFixtures
  warmupFn = deps?.warmup ?? warmupSokkerProBoard
  fetchMomentumFn = deps?.fetchMomentum ?? fetchMomentumServer
}

export function setPollerLimitsForTests(
  opts: {
    fixtureTimeoutMs?: number
    tickWatchdogMs?: number
    liveLimit?: number
    finishedLimit?: number
    concurrency?: number
    inWindowConcurrency?: number
  } | null,
): void {
  fixtureTimeoutMs = opts?.fixtureTimeoutMs ?? POLLER_FIXTURE_TIMEOUT_MS
  tickWatchdogMs = opts?.tickWatchdogMs ?? POLLER_TICK_WATCHDOG_MS
  liveLimit = opts?.liveLimit ?? POLLER_LIVE_LIMIT
  finishedLimit = opts?.finishedLimit ?? POLLER_FINISHED_LIMIT
  concurrency = opts?.concurrency ?? POLLER_CONCURRENCY
  inWindowConcurrency = opts?.inWindowConcurrency ?? POLLER_IN_WINDOW_CONCURRENCY
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
  inWindowConcurrency = POLLER_IN_WINDOW_CONCURRENCY
  currentTickStarted = 0
  processFixtureFn = processFixture
  fetchFixturesFn = defaultFetchFixtures
  warmupFn = warmupSokkerProBoard
  fetchMomentumFn = fetchMomentumServer
  status.lastTickAt = null
  status.lastError = null
  status.liveWatched = 0
  status.inWindowThisTick = 0
  status.lastAlertLatencyHint = null
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
  resetTelegramRetryForTests()
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

function halvesBundle(market: Market) {
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

function claimFreshAlerts(
  fixture: Fixture,
  market: Market,
  settings: ReturnType<typeof currentSettings>,
  byHalf: CornersByHalf | undefined,
  fresh: FeedAlert[],
  events: GoalEvent[],
  clock?: { min: number; period: number },
): FeedAlert[] {
  const claimed: FeedAlert[] = []
  const enforced = qualityOverlayEnabled()
  const storedByHalf = new Map<CornerHalf, LoggedAlert[]>()
  const storedFor = (half: CornerHalf): LoggedAlert[] => {
    let stored = storedByHalf.get(half)
    if (!stored) {
      stored = loadAlerts(market, half)
      storedByHalf.set(half, stored)
    }
    return stored
  }
  const claimedPassByHalf = new Map<CornerHalf, number>()
  const overlayPatches: { half: CornerHalf; loggedId: string; overlay: AlertOverlay }[] = []
  for (const alert of fresh) {
    // Stoppage (P1>45 / P2>90) and out-of-window: no push. Yeovil 96' arrived
    // after the goal; bookie markets were already gone.
    if (!inMarketClockWindow(market, alert.min, alert.period)) continue
    const reason = notifySuppressReason(
      alert,
      events,
      clock,
      MIN_NOTIFY_LEAD_MIN,
    )
    if (reason) {
      console.info(
        `[poller] suppress ${reason} ${alert.min}' P${alert.period} ${alert.matchLabel}`,
      )
      continue
    }
    const notify = settingsForAlert(alert, settings, byHalf)
    if (!ruleNotifyEnabled(notify, alert.rule)) continue
    const key = sentKey(market, fixture.id, alert.id, alert.cornerHalf)
    if (loadSent().includes(key)) continue

    // Quality overlay (notification filter only; the alert is already stored
    // and will be settled/learned like every other). Cap: one overlay-passed
    // notified alert per match × market × half, counted from stored alerts.
    const half = alertHalf(market, alert)
    let overlay = alert.overlay ?? overlayForFeedAlert(market, alert, enforced)
    if (overlay.pass && half) {
      const capped = overlayCapReached(
        storedFor(half),
        fixture.id,
        claimedPassByHalf.get(half) ?? 0,
      )
      if (capped) overlay = withCapReason(overlay)
    }
    const loggedId = loggedAlertId(fixture.id, alert.id)
    if (enforced && !overlay.pass) {
      // Decided once: consume the sent key so the blocked alert is not
      // re-considered every tick.
      markSent(key)
      if (half) overlayPatches.push({ half, loggedId, overlay })
      console.info(
        `[poller] overlay block ${overlay.reasons.join(',')} ${market} ${alert.min}' P${alert.period} ${alert.matchLabel}`,
      )
      continue
    }
    if (!markSent(key)) continue
    if (overlay.pass && half) {
      overlay = { ...overlay, notified: true }
      claimedPassByHalf.set(half, (claimedPassByHalf.get(half) ?? 0) + 1)
    }
    if (half) overlayPatches.push({ half, loggedId, overlay })
    claimed.push({ ...alert, overlay })
  }
  // Persist overlay decisions (cap / notified) — one write per touched half.
  for (const half of new Set(overlayPatches.map((p) => p.half))) {
    const stored = storedFor(half)
    let dirty = false
    for (const patch of overlayPatches) {
      if (patch.half !== half) continue
      const idx = stored.findIndex((a) => a.id === patch.loggedId)
      if (idx < 0) continue
      stored[idx] = { ...stored[idx], overlay: patch.overlay }
      dirty = true
    }
    if (dirty) saveAlerts(stored, market, half)
  }
  return claimed
}

function recordAlertLatency(fixture: Fixture, alert: FeedAlert): void {
  const sentAt = new Date().toISOString()
  const tickLagMs = currentTickStarted ? Date.now() - currentTickStarted : 0
  status.lastAlertLatencyHint = {
    clockMin: alert.min,
    period: alert.period,
    sentAt,
    tickLagMs,
    matchLabel: alert.matchLabel,
    fixtureId: fixture.id,
  }
  console.info(
    `[poller] telegram clock=${alert.min}' P${alert.period} sentAt=${sentAt} tickLagMs=${tickLagMs} ${alert.matchLabel}`,
  )
}

async function noteTelegramDelivered(
  fixture: Fixture,
  market: Market,
  alert: FeedAlert,
  alertKey: string,
  telegramResult: TelegramSendResult,
): Promise<void> {
  recordAlertLatency(fixture, alert)
  if (telegramResult.messageId != null) {
    await withStoreLock(() => {
      markAlertTelegramMessage(
        alertKey,
        telegramResult.messageId!,
        market,
        alert.cornerHalf,
      )
    })
  }
}

/**
 * Lead gate for a retry, on the latest stored snapshot (the poller saves it
 * every tick): same notifySuppressReason as the live path, plus "period
 * changed / match over". Also stops if the alert is already delivered.
 */
function telegramRetryDropReason(
  fixture: Fixture,
  market: Market,
  alert: FeedAlert,
  alertKey: string,
): string | null {
  const rec = getTelegramMessage(alertKey)
  if (rec && rec.messageId > 0 && (telegramRecordMarket(rec) ?? market) === market) {
    return 'já entregue'
  }
  const stored = loadMatch(fixture.id)
  if (!stored) return null
  if (stored.finished) return 'jogo terminado'
  const settings = currentSettings(market)
  const points = normalizeTimeline(stored.payload, settings.sustainedThreshold)
  const clock = points.at(-1)
  if (clock && clock.period !== alert.period) return 'parte terminou'
  const events = extractMarketEvents(stored.payload, points, market)
  const reason = notifySuppressReason(alert, events, clock, MIN_NOTIFY_LEAD_MIN)
  return reason ? `lead: ${reason}` : null
}

/** A retry delivered after the tick: same bookkeeping as an inline delivery. */
async function completeLateTelegramDelivery(
  fixture: Fixture,
  market: Market,
  alert: FeedAlert,
  alertKey: string,
  telegramResult: TelegramSendResult,
): Promise<void> {
  await noteTelegramDelivered(fixture, market, alert, alertKey, telegramResult)
  const loggedId = loggedAlertId(fixture.id, alert.id)
  await withStoreLock(() => {
    markAlertPushed(loggedId, market, alert.cornerHalf)
  })
  status.alertsSent += 1
  // Tips open only for delivered alerts; use the odds the attach step stored.
  await settleOddsAttach()
  await withStoreLock(() => {
    const logged = loadAlerts(market, alert.cornerHalf).find((a) => a.id === loggedId)
    const enriched = logged?.odds ? { ...alert, odds: logged.odds } : alert
    const odd = resolvedOddFromAlert(enriched)
    if (odd && !tipAlreadyOpen(fixture.id, alert.id, market)) {
      createTipFromAlert({ fixture, alert: enriched, odd })
    }
  })
}

async function dispatchClaimedAlerts(
  fixture: Fixture,
  market: Market,
  claimed: FeedAlert[],
): Promise<{ sent: number; notified: FeedAlert[] }> {
  let sent = 0
  const notified: FeedAlert[] = []
  for (const alert of claimed) {
    const copy = alertNotificationCopy(alert)
    // UI deep link / learning-store id stay `fixture:alert`; the Telegram side
    // map + outcome/callback key is market-qualified (corners prefixed).
    const loggedId = loggedAlertId(fixture.id, alert.id)
    const alertKey = alertKeyFor(market, fixture.id, alert.id)
    const monitorUrl = `/#/monitor?alert=${encodeURIComponent(loggedId)}`
    const key = sentKey(market, fixture.id, alert.id, alert.cornerHalf)
    let notifiedOk = false
    const telegramPayload = {
      title: copy.title,
      body: copy.body,
      url: monitorUrl,
      alertKey,
      ruleLabel: alert.ruleName,
      market,
      qualityLine:
        alert.overlay?.enforced && alert.overlay.pass ? QUALITY_FILTER_LINE : undefined,
    }
    const firstAttemptAt = telegramRetryNow()
    const telegramResult: TelegramSendResult = await sendTelegram(telegramPayload)
    if (telegramResult.sent > 0) {
      notifiedOk = true
      await noteTelegramDelivered(fixture, market, alert, alertKey, telegramResult)
    } else if (!telegramResult.skipped) {
      // Transient failures retry in the background (bounded, lead-gated).
      const retrying = scheduleTelegramRetry(
        {
          key: alertKey,
          firstAttemptAt,
          send: () => sendTelegram(telegramPayload),
          dropReason: () => telegramRetryDropReason(fixture, market, alert, alertKey),
          onDelivered: (result) =>
            completeLateTelegramDelivery(fixture, market, alert, alertKey, result),
        },
        telegramResult,
      )
      console.error(
        '[poller] telegram não enviado',
        alertKey,
        telegramResult.reason || 'sem detalhe',
        retrying ? '(retry agendado)' : '',
      )
    }
    if (webPushEnabled()) {
      const result: PushSendResult = await sendPush({
        title: copy.title,
        body: copy.body,
        url: monitorUrl,
        alertKey: loggedId,
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
      await withStoreLock(() => {
        markAlertPushed(loggedId, market, alert.cornerHalf)
      })
      notified.push(alert)
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
    if (odd && !tipAlreadyOpen(args.fixture.id, alert.id, args.market)) {
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
  // Every evaluated alert carries its overlay decision (stored with it).
  const fresh = annotateOverlay(
    market,
    args.fresh.filter((alert) => inMarketClockWindow(market, alert.min, alert.period)),
  )

  if (first) {
    await withStoreLock(() => {
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

  // Claim sent-keys + ingest under the store lock; Telegram is outside so one
  // fixture's HTTP cannot block the next in-window evaluate.
  const claimed = await withStoreLock(() => {
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
    return claimFreshAlerts(
      fixture,
      market,
      settings,
      byHalf,
      fresh,
      events,
      clock,
    )
  })

  const { sent, notified } = await dispatchClaimedAlerts(fixture, market, claimed)
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

/** One market's evaluate on a payload — unchanged rules/windows per market. */
function evaluateMarket(payload: MomentumPayload, market: Market) {
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
  return { market, settings, byHalf, points, alerts, events, eventKeys }
}

async function processFixture(fixture: Fixture, signal?: AbortSignal): Promise<number> {
  const payload = await fetchMomentumFn(fixture.id, signal)
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('abortado')
  }
  lastMomentumOkAt.set(fixture.id, Date.now())
  jsonBackoff.noteSuccess(fixture.id)
  const finished = fixture.state === 2 || fixture.status >= 100

  const evaluated = EVALUATED_MARKETS.map((market) => evaluateMarket(payload, market))

  // One snapshot per fixture; each market primes separately (primedKey is
  // market-unique), so a market's first sight of a live match never pushes.
  const firsts = await withStoreLock(() => {
    saveMatch({
      fixture,
      payload,
      finished,
      updatedAt: new Date().toISOString(),
    })
    return evaluated.map(({ market }) => {
      const primedId = primedKey(market, fixture.id)
      const isFirst = !isPrimed(primedId)
      if (isFirst) primeFixture(primedId)
      return isFirst
    })
  })

  // Markets run side by side: claims serialise on the store lock, Telegram
  // sends go out concurrently so one market never delays the other.
  const sent = await Promise.all(
    evaluated.map(({ market, settings, byHalf, points, alerts, events, eventKeys }, i) => {
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
        first: firsts[i]!,
        finished,
        payload,
        events,
        points,
      })
    }),
  )
  return sent.reduce((sum, n) => sum + n, 0)
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
  currentTickStarted = started
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
    const { inWindow, fill } = selectLiveTargets({
      live,
      // Corners are always evaluated now, so their pre-window boost always applies.
      market: EVALUATED_MARKETS.includes('corners') ? 'corners' : 'goals',
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
    const restTargets = [...fill, ...recentDone]
    const targets = [...inWindow, ...restTargets]
    tickIndex += 1
    status.liveWatched = live.length
    status.inWindowThisTick = inWindow.length
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
    const runTargets = async (batch: Fixture[], workerLimit: number) =>
      mapLimit(batch, workerLimit, async (fixture) => {
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
      })
    // In-window first, higher concurrency; Telegram fires inside each evaluate.
    const inWindowSent = await runTargets(inWindow, inWindowConcurrency)
    const restSent = await runTargets(restTargets, concurrency)
    if (tickGen !== gen) return
    const sent = [...inWindowSent, ...restSent].reduce((sum, n) => sum + n, 0)
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
