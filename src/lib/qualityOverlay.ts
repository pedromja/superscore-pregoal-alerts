/**
 * Quality overlay — a NOTIFICATION filter on top of the locked definitions.
 *
 * The locked rules/thresholds/windows/lead gate are untouched: every Primary
 * alert is still generated, stored, settled and learned from. This overlay
 * only decides which Primary alerts go to Telegram / push (backtest on real
 * delivered alerts, 26/set/2026). No league bans, no odds filters.
 *
 *  - Corners HT (32–42): minute ≤ 38.
 *  - Goals HT: |v| ≥ 85 ∧ (|Δ1| ≥ 70 ∨ Sustained |v|≥30 ×4), |goal diff| ≤ 1.
 *    Same metric definitions as the locked Primary (absValue, absDelta1 and
 *    the run length at the locked sustainedThreshold 30 = `sustainedLength`).
 *  - FT goals / FT corners: the pressing side (alert side = momentum sign)
 *    is NOT currently winning; unknown side → `side-unknown`.
 *  - Max one overlay-passed notified alert per match × market × half
 *    (enforced by the server from stored alerts, see server/qualityOverlay).
 */
import type { AlertOverlay, CornerHalf, Market, MatchTally, RuleId, Side } from './types'

export const QUALITY_OVERLAY_VERSION = 'q1-2026-09-26'

export const QUALITY_OVERLAY_LIMITS = {
  cornersHtMaxMinute: 38,
  goalsHtSpike: 85,
  goalsHtSwing: 70,
  goalsHtSustainedValue: 30,
  goalsHtSustainedMinutes: 4,
  goalsHtMaxGoalDiff: 1,
  maxNotifiedPerMatchHalf: 1,
} as const

export const OVERLAY_REASON = {
  notPrimary: 'not-primary',
  cornersHtLate: 'corners-ht-min>38',
  goalsHtSpike: 'goals-ht-spike<85',
  goalsHtNoSwingOrSustained: 'goals-ht-no-swing70-or-sust4',
  goalDiff: 'goal-diff>1',
  scoreUnknown: 'score-unknown',
  sideUnknown: 'side-unknown',
  pressingSideWinning: 'pressing-side-winning',
  cap: 'cap-1-per-match-half',
} as const

export type OverlayInput = {
  market: Market
  half: CornerHalf
  rule: RuleId
  min: number
  side?: Side | null
  /** Signed momentum at the alert point (locked `point.value`). */
  momentum: number
  /** Signed Δ1 at the alert point (locked `point.delta1`). */
  delta1: number | null
  /** Locked Primary run length at `sustainedThreshold` (30 for goals). */
  sustainedLength: number
  /** Goals score at the alert minute (from the momentum feed events). */
  goalsTally?: MatchTally | null
}

/** Rule-level reasons (empty = passes the rules; the cap is separate). */
export function overlayRuleReasons(input: OverlayInput): string[] {
  if (input.rule !== 'primary') return [OVERLAY_REASON.notPrimary]
  const L = QUALITY_OVERLAY_LIMITS
  const reasons: string[] = []
  if (input.half === 'ht') {
    if (input.market === 'corners') {
      if (input.min > L.cornersHtMaxMinute) reasons.push(OVERLAY_REASON.cornersHtLate)
      return reasons
    }
    // Goals HT
    if (Math.abs(input.momentum) < L.goalsHtSpike) reasons.push(OVERLAY_REASON.goalsHtSpike)
    const swing = input.delta1 !== null && Math.abs(input.delta1) >= L.goalsHtSwing
    const sustained = input.sustainedLength >= L.goalsHtSustainedMinutes
    if (!swing && !sustained) reasons.push(OVERLAY_REASON.goalsHtNoSwingOrSustained)
    const t = input.goalsTally
    if (!t) reasons.push(OVERLAY_REASON.scoreUnknown)
    else if (Math.abs(t.home - t.away) > L.goalsHtMaxGoalDiff) reasons.push(OVERLAY_REASON.goalDiff)
    return reasons
  }
  // FT goals + FT corners: pressing side must not be winning.
  const side = input.side
  if (side !== 'home' && side !== 'away') return [OVERLAY_REASON.sideUnknown]
  const t = input.goalsTally
  if (!t) return [OVERLAY_REASON.scoreUnknown]
  const own = side === 'home' ? t.home : t.away
  const other = side === 'home' ? t.away : t.home
  if (own > other) reasons.push(OVERLAY_REASON.pressingSideWinning)
  return reasons
}

export function overlayDecision(input: OverlayInput, enforced: boolean): AlertOverlay {
  const reasons = overlayRuleReasons(input)
  return {
    version: QUALITY_OVERLAY_VERSION,
    pass: reasons.length === 0,
    reasons,
    enforced,
  }
}

export function withCapReason(overlay: AlertOverlay): AlertOverlay {
  return {
    ...overlay,
    pass: false,
    reasons: [...overlay.reasons.filter((r) => r !== OVERLAY_REASON.cap), OVERLAY_REASON.cap],
  }
}

/** `QUALITY_OVERLAY=on|off` (also 1/0, true/false, yes/no). Default on. */
export function parseQualityOverlayEnv(raw: string | undefined): boolean {
  const v = (raw ?? '').trim().toLowerCase()
  if (!v) return true
  if (['off', '0', 'false', 'no', 'disabled'].includes(v)) return false
  return true
}

/** Short header line for a Telegram alert that passed the filter. */
export const QUALITY_FILTER_LINE = '✅ Filtro'
