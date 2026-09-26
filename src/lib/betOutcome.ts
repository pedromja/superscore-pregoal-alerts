/**
 * Bet outcome ("+0.5" on the market total) for alerts and tips.
 *
 * Separate from the learning labels (hit5 / hitLong use the ≤5 / 15 min
 * horizons and feed auto-learning; they are untouched). This one decides the
 * GREEN/RED shown on Telegram and counted in green/red, overlay, tips ROI,
 * league follow-up and the league line:
 *
 * - both teams count (corners type 14, goals type 4);
 * - baseline = market total at the alert minute (the score printed on the
 *   alert; events at the alert minute are part of it);
 * - HT alerts run to the half-time whistle (period 1, stoppage included, e.g.
 *   47' = 45+2), FT alerts to the final whistle (period 2, e.g. 94' = 90+4);
 *   extra time never counts;
 * - GREEN as soon as one more event of the market appears in that period;
 * - RED only once the period is confirmed over: data from a later period
 *   (HT: 2nd-half timeline/events), or the match finished (state 2 / status
 *   ≥ 100). The clock alone (42' / 45' / 90') never decides RED;
 * - if the end cannot be confirmed: settle on the last known count once the
 *   feed has been silent for STALE_AFTER_MS with the clock at/after the
 *   regular end of the period, or HARD_TIMEOUT_MS after kick-off;
 * - a match whose feed has no events at all (no event coverage) is never RED.
 */
import { MARKET_EVENT_TYPE, marketCopy, parseMarket } from './market'
import type { CornerHalf, Market, RawMomentumEvent } from './types'

export const BET_RULE = 'half-end-v1'
/** No new data for this long after the regular end of the period ⇒ settle. */
export const BET_STALE_AFTER_MS = 30 * 60_000
/** Kick-off + this ⇒ the match is over whatever the feed says. */
export const BET_HARD_TIMEOUT_MS = 4 * 60 * 60_000

export type BetEvent = { min: number; period: number; side: 'home' | 'away' }

export type BetOutcome = {
  status: 'green' | 'red'
  rule: typeof BET_RULE
  baseline: number
  total: number
  targetPeriod: 1 | 2
  /** GREEN: first event after the alert (minute as in the feed, 47 = 45+2). */
  event: BetEvent | null
  /** RED: last minute seen in the target period (stoppage), null if unknown. */
  endMin: number | null
  reason: 'event' | 'period-over' | 'finished' | 'stale' | 'timeout'
  decidedAt: string
}

export type BetDecision =
  | BetOutcome
  | {
      status: 'pending'
      baseline: number
      total: number
      targetPeriod: 1 | 2
      endMin: number | null
      /** The feed has no events at all for this match: RED can't be proven. */
      noCoverage?: boolean
    }

export type BetInput = {
  market: Market
  half: CornerHalf | null | undefined
  alertMin: number
  alertPeriod: number
  /** Printed baseline (send snapshot / tally); computed from events if absent. */
  baseline?: number | null
  events: RawMomentumEvent[] | null | undefined
  points?: { min: number; period: number }[] | null
  finished?: boolean
  /** Last time the match data was refreshed (ms). */
  updatedAtMs?: number | null
  /** Kick-off (ms). */
  kickoffMs?: number | null
  nowMs?: number
}

export function betTargetPeriod(half: CornerHalf | null | undefined, alertPeriod: number): 1 | 2 {
  if (half === 'ht') return 1
  if (half === 'ft') return 2
  return alertPeriod <= 1 ? 1 : 2
}

function after(a: { min: number; period: number }, b: { min: number; period: number }): boolean {
  return a.period > b.period || (a.period === b.period && a.min > b.min)
}

export function computeBetOutcome(input: BetInput): BetDecision {
  const type = MARKET_EVENT_TYPE[parseMarket(input.market)]
  const target = betTargetPeriod(input.half, input.alertPeriod)
  const at = { min: input.alertMin, period: input.alertPeriod }
  const ofType = (input.events ?? [])
    .filter((e) => e.type === type)
    .slice()
    .sort((a, b) => a.period - b.period || a.min - b.min)
  // Events that count for this bet: both teams, up to the end of the target
  // period (stoppage included; extra time never).
  const inScope = ofType.filter((e) => e.period <= target)
  const computedBaseline = inScope.filter((e) => !after(e, at)).length
  const printed =
    typeof input.baseline === 'number' && Number.isFinite(input.baseline)
      ? input.baseline
      : null
  const baseline = printed ?? computedBaseline
  // GREEN ⇔ the count is above the baseline. The printed total can already
  // include events between the alert minute and the send (same minute), and a
  // lagging feed tally never turns a pre-alert event into a GREEN.
  const threshold = Math.max(baseline, computedBaseline)
  const extra = inScope.slice(threshold)
  const total = Math.max(baseline, inScope.length)
  const inTarget = [
    ...(input.points ?? []).filter((p) => p.period === target).map((p) => p.min),
    ...(input.events ?? []).filter((e) => e.period === target).map((e) => e.min),
  ]
  const endMin = inTarget.length ? Math.max(...inTarget) : null
  const decidedAt = new Date(input.nowMs ?? Date.now()).toISOString()
  const base = { rule: BET_RULE, baseline, total, targetPeriod: target, decidedAt } as const

  if (extra.length) {
    const e = extra[0]
    return {
      ...base,
      status: 'green',
      event: { min: e.min, period: e.period, side: e.side === 2 ? 'away' : 'home' },
      endMin,
      reason: 'event',
    }
  }
  const maxPeriod = Math.max(
    0,
    ...(input.points ?? []).map((p) => p.period),
    ...(input.events ?? []).map((e) => e.period),
  )
  const red = (reason: BetOutcome['reason']): BetOutcome => ({
    ...base,
    status: 'red',
    event: null,
    endMin,
    reason,
  })
  // No events of any type in the feed (some leagues have no event coverage):
  // "no extra event" is unknowable, so never RED — stays undecided.
  if (!(input.events ?? []).length) {
    return { status: 'pending', baseline, total, targetPeriod: target, endMin, noCoverage: true }
  }
  if (maxPeriod > target) return red('period-over')
  if (input.finished) return red('finished')
  const now = input.nowMs ?? Date.now()
  const regularEnd = target === 1 ? 45 : 90
  if (
    input.updatedAtMs != null &&
    now - input.updatedAtMs >= BET_STALE_AFTER_MS &&
    maxPeriod === target &&
    endMin != null &&
    endMin >= regularEnd
  ) {
    return red('stale')
  }
  if (input.kickoffMs != null && input.kickoffMs > 0 && now - input.kickoffMs >= BET_HARD_TIMEOUT_MS) {
    return red('timeout')
  }
  return { status: 'pending', baseline, total, targetPeriod: target, endMin }
}

/** `44'`, `45+2'`, `90+4'` (feed minutes run on through stoppage). */
export function formatMatchMinute(min: number, period: number): string {
  if (period === 1 && min > 45) return `45+${min - 45}'`
  if (period === 2 && min > 90) return `90+${min - 90}'`
  return `${min}'`
}

/** Result detail: `canto aos 44'` / `sem canto até ao intervalo (45+2')` / `sem golo até ao fim (90+5')`. */
export function formatBetDetail(outcome: Pick<BetOutcome, 'status' | 'event' | 'endMin' | 'targetPeriod'>, market: Market): string {
  const noun = marketCopy(parseMarket(market)).noun
  if (outcome.status === 'green') {
    return outcome.event ? `${noun} aos ${formatMatchMinute(outcome.event.min, outcome.event.period)}` : ''
  }
  const end = outcome.targetPeriod === 1 ? 'até ao intervalo' : 'até ao fim'
  const regular = outcome.targetPeriod === 1 ? 45 : 90
  const endMin = outcome.endMin != null && outcome.endMin >= regular ? outcome.endMin : null
  const when = endMin != null ? ` (${formatMatchMinute(endMin, outcome.targetPeriod)})` : ''
  return `sem ${noun} ${end}${when}`
}

export function isBetDecided(outcome: { status?: string } | null | undefined): outcome is BetOutcome {
  return outcome?.status === 'green' || outcome?.status === 'red'
}
