/**
 * Bet-outcome settlement (see src/lib/betOutcome.ts for the rule).
 *
 * - Live: the poller notes each processed match (`noteBetCandidate`) when the
 *   fixture still has undecided alerts; `flushBetSettlements` (debounced, under
 *   the poller's store lock) loads each affected scope once, stores
 *   `betOutcome` on newly decided alerts, updates their tips and queues the
 *   Telegram result edit for recently sent alerts.
 * - Sweep: every BET_SWEEP_MS the flush also looks at undecided fixtures that
 *   are no longer live (match snapshot on disk; stale/timeout rules close them).
 * - Boot: `resettleAllBets` recomputes every stored alert and tip that has no
 *   bet outcome yet (the one-off re-settle), without notifying; recently sent
 *   Telegram alerts are corrected by `runResettleEdits` (edits only, ~1/s).
 */
import { isBetDecided, type BetOutcome } from '../src/lib/betOutcome.ts'
import { applyBetToTip, decideBetForAlert, decideBetForMatch, decideBetForTip } from './betDecide.ts'
import type { Tip } from '../src/lib/tips.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { loggedAlertKey } from './alertKeys.ts'
import { betPending, observeBetPending, pendingBetsFor, pendingFixtures, scopesWithPending } from './betIndex.ts'
import {
  getTelegramMessage,
  loadAlerts,
  loadMatch,
  loadTips,
  saveAlerts,
  saveTips,
  upsertTelegramMessage,
} from './store.ts'
import { formatTelegramResultLine } from './telegramCompose.ts'
import { requestTelegramAlertEdit, telegramRecordEditable, alertEditSucceeded, inlineEditsActive } from './telegramEdits.ts'
import { enqueueTelegramOutcome, scheduleTelegramOutcomeFlush } from './telegramOutcomes.ts'
import type { LoggedAlert, StoredMatch } from './types.ts'

const SCOPES: { market: Market; half: CornerHalf }[] = [
  { market: 'goals', half: 'ht' },
  { market: 'goals', half: 'ft' },
  { market: 'corners', half: 'ht' },
  { market: 'corners', half: 'ft' },
]
export const BET_SWEEP_MS = 5 * 60_000
/** Live GREEN/RED notices only for alerts sent this recently (no storms from old data). */
export const BET_NOTIFY_MAX_AGE_MS = 12 * 60 * 60_000

const liveMatches = new Map<string, StoredMatch>()
let lastSweepAt = 0

/** Settle tips of these fixtures by the bet rule (open ones and not yet re-settled ones). */
export function settleTipsByBet(matches: Map<string, StoredMatch | null>, nowMs = Date.now()): Tip[] {
  if (!matches.size) return []
  const tips = loadTips()
  const nowIso = new Date(nowMs).toISOString()
  const changed: Tip[] = []
  const next = tips.map((tip) => {
    if (tip.betOutcome) return tip
    if (!matches.has(tip.fixtureId)) return tip
    const updated = applyBetToTip(tip, decideBetForTip(tip, matches.get(tip.fixtureId) ?? null, nowMs), nowIso)
    if (!updated) return tip
    changed.push(updated)
    return updated
  })
  if (changed.length) saveTips(next)
  return changed
}

function recentlySent(alert: LoggedAlert, nowMs: number, maxAgeMs: number): boolean {
  const at = Date.parse(alert.telegramSentAt ?? alert.ts)
  return Number.isFinite(at) && nowMs - at <= maxAgeMs
}

/** Store decisions for the fixtures' undecided alerts in one scope. */
function settleScope(
  scope: { market: Market; half: CornerHalf },
  matches: Map<string, StoredMatch | null>,
  nowMs: number,
): LoggedAlert[] {
  const alerts = loadAlerts(scope.market, scope.half)
  const newly: LoggedAlert[] = []
  let changed = false
  const next = alerts.map((alert) => {
    if (!betPending(alert) || !matches.has(alert.fixtureId)) return alert
    const decision = decideBetForAlert(alert, matches.get(alert.fixtureId) ?? null, scope, nowMs)
    if (!decision || !isBetDecided(decision)) return alert
    changed = true
    const updated: LoggedAlert = { ...alert, market: alert.market ?? scope.market, betOutcome: decision }
    newly.push(updated)
    return updated
  })
  if (changed) saveAlerts(next, scope.market, scope.half)
  return newly
}

/** Poller: remember the latest snapshot of a fixture that still has undecided alerts. */
export function noteBetCandidate(match: StoredMatch): boolean {
  if (!scopesWithPending(match.fixture.id).length) return false
  liveMatches.set(match.fixture.id, match)
  return true
}

export function pendingBetCandidates(): number {
  return liveMatches.size
}

export type BetFlushResult = { decided: number; green: number; red: number; notified: number; tips: number }

/** Synchronous; call under the poller's store lock. */
export function flushBetSettlements(opts: { notify?: boolean; sweep?: boolean; nowMs?: number } = {}): BetFlushResult {
  const nowMs = opts.nowMs ?? Date.now()
  const matches = new Map<string, StoredMatch | null>(liveMatches)
  liveMatches.clear()
  const doSweep = opts.sweep ?? nowMs - lastSweepAt >= BET_SWEEP_MS
  if (doSweep) {
    lastSweepAt = nowMs
    for (const id of pendingFixtures()) {
      if (!matches.has(id)) matches.set(id, loadMatch(id))
    }
  }
  const result: BetFlushResult = { decided: 0, green: 0, red: 0, notified: 0, tips: 0 }
  if (!matches.size) return result
  const newly: LoggedAlert[] = []
  for (const scope of SCOPES) {
    // Load/parse the scope file only when one of its pending alerts can be decided now.
    const decidable = [...matches.entries()].some(([id, match]) =>
      pendingBetsFor(scope.market, scope.half, id).some((lite) => {
        const d = decideBetForMatch({ market: scope.market, half: scope.half, ...lite }, match, nowMs)
        return Boolean(d && isBetDecided(d))
      }),
    )
    if (decidable) newly.push(...settleScope(scope, matches, nowMs))
  }
  if (newly.length) {
    const decidedFixtures = new Map<string, StoredMatch | null>()
    for (const a of newly) decidedFixtures.set(a.fixtureId, matches.get(a.fixtureId) ?? null)
    result.tips = settleTipsByBet(decidedFixtures, nowMs).length
  }
  for (const alert of newly) {
    result.decided += 1
    if (alert.betOutcome?.status === 'green') result.green += 1
    else result.red += 1
    if (opts.notify === false) continue
    if (!alert.telegramMessageId && !alert.sentPush) continue
    if (!recentlySent(alert, nowMs, BET_NOTIFY_MAX_AGE_MS)) continue
    enqueueTelegramOutcome(loggedAlertKey(alert))
    result.notified += 1
  }
  if (result.notified) scheduleTelegramOutcomeFlush()
  if (result.decided) {
    console.log(
      `[bet] ${result.decided} decididos (🟢 ${result.green} · 🔴 ${result.red}), ${result.tips} tips, ${result.notified} a notificar`,
    )
  }
  return result
}

function learningOutcome(alert: LoggedAlert): 'green' | 'red' | null {
  if (alert.hit5 == null && alert.hitLong == null) return null
  return alert.hit5 === true || alert.hitLong === true ? 'green' : 'red'
}

export type ResettleReport = {
  at: string
  alerts: {
    decided: number
    green: number
    red: number
    pending: number
    /** vs the old (learning-horizon) GREEN/RED of the same alert */
    redToGreen: number
    greenToRed: number
    sameAsOld: number
    wasUnsettled: number
  }
  sent48h: { decided: number; redToGreen: number; greenToRed: number; wasUnsettled: number; edits: number }
  tips: { resettled: number; lostToWon: number; wonToLost: number; openToWon: number; openToLost: number }
  editKeys: string[]
}

/**
 * One-off re-settle of every stored alert/tip without a bet outcome, from the
 * stored match snapshots. Returns the report + the keys whose Telegram message
 * should show a corrected result (sent within `editWindowMs`).
 */
export function resettleAllBets(opts: { nowMs?: number; editWindowMs?: number } = {}): ResettleReport {
  const nowMs = opts.nowMs ?? Date.now()
  const editWindowMs = opts.editWindowMs ?? 48 * 60 * 60_000
  const cache = new Map<string, StoredMatch | null>()
  const matchOf = (id: string) => {
    if (!cache.has(id)) cache.set(id, loadMatch(id))
    return cache.get(id) ?? null
  }
  const report: ResettleReport = {
    at: new Date(nowMs).toISOString(),
    alerts: { decided: 0, green: 0, red: 0, pending: 0, redToGreen: 0, greenToRed: 0, sameAsOld: 0, wasUnsettled: 0 },
    sent48h: { decided: 0, redToGreen: 0, greenToRed: 0, wasUnsettled: 0, edits: 0 },
    tips: { resettled: 0, lostToWon: 0, wonToLost: 0, openToWon: 0, openToLost: 0 },
    editKeys: [],
  }
  for (const scope of SCOPES) {
    const alerts = loadAlerts(scope.market, scope.half)
    let changed = false
    const next = alerts.map((alert) => {
      if (!betPending(alert)) return alert
      const decision = decideBetForAlert(alert, matchOf(alert.fixtureId), scope, nowMs)
      if (!decision || !isBetDecided(decision)) {
        report.alerts.pending += 1
        return alert
      }
      changed = true
      const updated: LoggedAlert = { ...alert, market: alert.market ?? scope.market, betOutcome: decision }
      const old = learningOutcome(alert)
      report.alerts.decided += 1
      if (decision.status === 'green') report.alerts.green += 1
      else report.alerts.red += 1
      if (old === null) report.alerts.wasUnsettled += 1
      else if (old === decision.status) report.alerts.sameAsOld += 1
      else if (old === 'red') report.alerts.redToGreen += 1
      else report.alerts.greenToRed += 1
      if (alert.telegramMessageId && recentlySent(alert, nowMs, editWindowMs)) {
        report.sent48h.decided += 1
        if (old === null) report.sent48h.wasUnsettled += 1
        else if (old !== decision.status) {
          if (old === 'red') report.sent48h.redToGreen += 1
          else report.sent48h.greenToRed += 1
        }
        report.editKeys.push(loggedAlertKey(updated))
      }
      return updated
    })
    if (changed) saveAlerts(next, scope.market, scope.half)
    else observeBetPending(next, scope.market, scope.half)
  }
  const tips = loadTips()
  const nowIso = new Date(nowMs).toISOString()
  let tipsChanged = false
  const nextTips = tips.map((tip) => {
    if (tip.betOutcome) return tip
    const updated = applyBetToTip(tip, decideBetForTip(tip, matchOf(tip.fixtureId), nowMs), nowIso)
    if (!updated) {
      // Decided the same way as before: still record the bet outcome.
      const decision = decideBetForTip(tip, matchOf(tip.fixtureId), nowMs)
      if (decision && isBetDecided(decision)) {
        tipsChanged = true
        report.tips.resettled += 1
        return { ...tip, betOutcome: decision }
      }
      return tip
    }
    tipsChanged = true
    report.tips.resettled += 1
    if (tip.status === 'lost' && updated.status === 'won') report.tips.lostToWon += 1
    if (tip.status === 'won' && updated.status === 'lost') report.tips.wonToLost += 1
    if (tip.status === 'open' && updated.status === 'won') report.tips.openToWon += 1
    if (tip.status === 'open' && updated.status === 'lost') report.tips.openToLost += 1
    return updated
  })
  if (tipsChanged) saveTips(nextTips)
  return report
}

/** Current stored alerts for these keys (one load per scope, not one parse per key). */
export function alertsByKeys(keys: string[]): Map<string, LoggedAlert> {
  const wanted = new Set(keys)
  const out = new Map<string, LoggedAlert>()
  if (!wanted.size) return out
  for (const scope of SCOPES) {
    for (const alert of loadAlerts(scope.market, scope.half)) {
      const key = loggedAlertKey({ ...alert, market: alert.market ?? scope.market })
      if (wanted.has(key) && !out.has(key)) out.set(key, alert)
    }
  }
  return out
}

let editDelayMs = 1_100
export function setResettleEditDelayForTests(ms: number | null): void {
  editDelayMs = ms ?? 1_100
}

/**
 * Correct the result shown on recently sent alerts: set the bet result line and
 * edit (serialised, ~1 edit/s, no new messages, no reply fallback).
 */
export async function runResettleEdits(
  keys: string[],
  findAlert: (key: string) => LoggedAlert | null,
): Promise<{ edited: number; unchanged: number; failed: number; skipped: number }> {
  const out = { edited: 0, unchanged: 0, failed: 0, skipped: 0 }
  if (!inlineEditsActive()) {
    out.skipped = keys.length
    return out
  }
  for (const key of keys) {
    const alert = findAlert(key)
    const rec = getTelegramMessage(key)
    if (!alert || alert.void || !alert.betOutcome || !telegramRecordEditable(rec)) {
      out.skipped += 1
      continue
    }
    const line = formatTelegramResultLine(alert)
    if (rec.resultLine === line && rec.finalized) {
      out.unchanged += 1
      continue
    }
    upsertTelegramMessage(key, { resultLine: line, outcomeSentAt: rec.outcomeSentAt ?? new Date().toISOString() })
    const res = await requestTelegramAlertEdit(key, 're-settle', { alert })
    if (res.kind === 'unchanged') out.unchanged += 1
    else if (alertEditSucceeded(res)) out.edited += 1
    else out.failed += 1
    if (res.kind !== 'unchanged') await new Promise((r) => setTimeout(r, editDelayMs))
  }
  return out
}

export function resetBetSettleForTests(): void {
  liveMatches.clear()
  lastSweepAt = 0
}

export type { BetOutcome }
export { applyBetToTip, decideBetForAlert, decideBetForTip }
