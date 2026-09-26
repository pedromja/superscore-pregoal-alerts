/**
 * Quick VOID check: VOID_CHECK_DELAY_MS (default 15 s) after a delivered
 * Telegram alert, re-read the feed and decide whether the line was already
 * beaten when the alert went out.
 *
 * Rule (annotation + stats exclusion only; thresholds, windows, lead gate
 * and overlay are untouched):
 *
 *   baseline  = market events (goals type 4 / corners type 14, any side) up to
 *               and including the alert minute in the payload the alert was
 *               sent from = the score printed in the message ("Golos 0-0").
 *   sendClock = latest momentum minute/period in that same payload.
 *   before    = events in the fresh feed strictly before sendClock
 *               (earlier period, or same period and min < sendClock.min).
 *
 *   before > baseline                       → VOID (line beaten before send)
 *   only extra events at sendClock minute   → "same-minute": NOT void.
 *                                             SuperScore events carry a
 *                                             minute, no timestamp, so the
 *                                             source cannot show the event
 *                                             was before the send moment.
 *   otherwise                               → clean (events after the send
 *                                             are legitimate GREENs).
 *
 * Sources: fresh SuperScore momentum (same endpoint as the poller); if that
 * fetch fails, the poller's latest stored snapshot (≤ one tick old). The
 * SokkerPro mini live-score gate (PR #17) is not part of this build, so it is
 * not used.
 */
import { MARKET_EVENT_TYPE, marketCopy, parseMarket } from '../src/lib/market.ts'
import type { Market, MomentumPayload, RawMomentumEvent } from '../src/lib/types.ts'
import { voidCheckDelayMs, voidCheckEnabled } from './config.ts'
import { fetchMomentumServer } from './ss.ts'
import { findLoggedAlert, loadMatch, patchLoggedAlert } from './store.ts'
import { inlineEditsActive, requestTelegramAlertEdit } from './telegramEdits.ts'
import { markTipVoidForAlert } from './tips.ts'
import type { AlertSendSnapshot, VoidCheckRecord, VoidCheckResult } from './types.ts'

export type VoidEvent = { min: number; period: number; side: 'home' | 'away' }

export type VoidDecision = {
  result: VoidCheckResult
  totalBeforeSend: number | null
  event?: VoidEvent | null
}

function byTime(a: VoidEvent, b: VoidEvent): number {
  return a.period - b.period || a.min - b.min
}

/** Market events in the payload up to and including a clock minute (period-aware). */
export function marketTotalAt(
  payload: Pick<MomentumPayload, 'events'> | null | undefined,
  market: Market,
  upTo: { min: number; period: number },
): number {
  const type = MARKET_EVENT_TYPE[parseMarket(market)]
  let n = 0
  for (const e of payload?.events ?? []) {
    if (e.type !== type) continue
    if (e.period < upTo.period || (e.period === upTo.period && e.min <= upTo.min)) n += 1
  }
  return n
}

/** Pure VOID rule — see the module comment. */
export function decideVoid(args: {
  market: Market
  events: RawMomentumEvent[] | null
  snapshot: Pick<AlertSendSnapshot, 'clockMin' | 'clockPeriod' | 'totalAtAlert'>
}): VoidDecision {
  const { snapshot } = args
  if (!args.events || snapshot.clockMin == null || snapshot.clockPeriod == null) {
    return { result: 'no-data', totalBeforeSend: null }
  }
  const clock = { min: snapshot.clockMin, period: snapshot.clockPeriod }
  const type = MARKET_EVENT_TYPE[parseMarket(args.market)]
  const ofType: VoidEvent[] = args.events
    .filter((e) => e.type === type)
    .map((e) => ({ min: e.min, period: e.period, side: e.side === 2 ? 'away' as const : 'home' as const }))
    .sort(byTime)
  const before = ofType.filter(
    (e) => e.period < clock.period || (e.period === clock.period && e.min < clock.min),
  )
  if (before.length > snapshot.totalAtAlert) {
    return {
      result: 'void',
      totalBeforeSend: before.length,
      event: before[snapshot.totalAtAlert] ?? before.at(-1) ?? null,
    }
  }
  const sameMinute = ofType.filter((e) => e.period === clock.period && e.min === clock.min)
  if (sameMinute.length && before.length + sameMinute.length > snapshot.totalAtAlert) {
    return { result: 'same-minute', totalBeforeSend: before.length, event: sameMinute[0] }
  }
  return { result: 'clean', totalBeforeSend: before.length }
}

export type VoidCheckJob = {
  alertKey: string
  market: Market
  fixtureId: string
  /** Rule-level alert id (tips are keyed by it). */
  alertId: string
  snapshot: AlertSendSnapshot
}

type FetchMomentumFn = typeof fetchMomentumServer
let fetchMomentum: FetchMomentumFn = fetchMomentumServer
let delayOverrideMs: number | null = null
let unrefTimers = true
const pending = new Set<Promise<void>>()

export function setVoidCheckForTests(
  opts: { fetchMomentum?: FetchMomentumFn | null; delayMs?: number | null; unref?: boolean } | null,
): void {
  fetchMomentum = opts?.fetchMomentum ?? fetchMomentumServer
  delayOverrideMs = opts?.delayMs ?? null
  unrefTimers = opts?.unref ?? true
}

export function pendingVoidChecksForTests(): number {
  return pending.size
}

export async function waitForVoidChecksForTests(): Promise<void> {
  while (pending.size) {
    await Promise.all([...pending])
  }
}

async function loadEvents(
  fixtureId: string,
): Promise<{ events: RawMomentumEvent[] | null; source: VoidCheckRecord['source'] }> {
  try {
    const payload = await fetchMomentum(fixtureId)
    return { events: payload.events ?? [], source: 'superscore-fresh' }
  } catch {
    const stored = loadMatch(fixtureId)
    if (stored) return { events: stored.payload.events ?? [], source: 'superscore-stored' }
    return { events: null, source: 'none' }
  }
}

/** Run one VOID check now. Idempotent: an alert already VOID is left alone. */
export async function runVoidCheck(job: VoidCheckJob): Promise<VoidCheckRecord | null> {
  const found = findLoggedAlert(job.alertKey)
  if (!found || found.alert.void) return null
  const { events, source } = await loadEvents(job.fixtureId)
  const decision = decideVoid({ market: job.market, events, snapshot: job.snapshot })
  const checkedAt = new Date().toISOString()
  const record: VoidCheckRecord = {
    checkedAt,
    result: decision.result,
    source,
    totalBeforeSend: decision.totalBeforeSend,
    totalAtAlert: job.snapshot.totalAtAlert,
    event: decision.event ?? null,
  }
  if (decision.result !== 'void') {
    patchLoggedAlert(job.alertKey, { voidCheck: record })
    return record
  }
  const e = decision.event
  const noun = marketCopy(job.market).noun
  const reason = e
    ? `linha já batida ao enviar: ${noun} aos ${e.min}' (P${e.period}) antes do relógio de envio ${job.snapshot.clockMin}' (P${job.snapshot.clockPeriod})`
    : 'linha já batida ao enviar'
  patchLoggedAlert(job.alertKey, { voidCheck: record, void: true, voidReason: reason, voidAt: checkedAt })
  markTipVoidForAlert(job.market, job.fixtureId, job.alertId, reason)
  console.info('[void]', job.alertKey, reason, `fonte=${source}`)
  if (inlineEditsActive()) await requestTelegramAlertEdit(job.alertKey, 'void')
  return record
}

/** Schedule the check VOID_CHECK_DELAY_MS after a delivered alert. Never blocks. */
export function scheduleVoidCheck(job: VoidCheckJob): boolean {
  if (!voidCheckEnabled()) return false
  const delay = delayOverrideMs ?? voidCheckDelayMs()
  const run = new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      runVoidCheck(job)
        .catch((err) => {
          console.warn('[void] check', job.alertKey, err instanceof Error ? err.message : err)
        })
        .finally(resolve)
    }, delay)
    // Production keeps the process alive anyway; unref lets one-shot scripts exit.
    if (unrefTimers) timer.unref?.()
  })
  pending.add(run)
  void run.then(() => pending.delete(run))
  return true
}
