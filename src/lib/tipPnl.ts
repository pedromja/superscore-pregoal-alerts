/**
 * Flat-stake accounting for tips (1u per tip, always).
 *
 * - won: odd - 1 · lost: -1 · half-won: (odd - 1) / 2 · half-lost: -0.5
 * - push / void / cancelled: 0 and NOT counted as settled (stake returned).
 * - ROI = sum(pnl) / units staked on settled tips that have a valid odd.
 *
 * PnL is always derived here from `odd` + `status`; the stored `tip.pnl` is
 * ignored, so no data migration is needed and history is restated on the fly.
 *
 * Odd validity: a tip's odd is only its price if it is the Over of exactly
 * "one more event" (current total + 0.5) on the MATCH total of the alert's
 * market for the alert's period — the same rule the live picker enforces since
 * f2808b3 (`isMatchTotalMarket` + `marketPeriodMatches`, `maisUmPriceOf`).
 * Tips stored before that fix may carry a team-total, 2nd-half-only or other
 * line price (odds of 5–30 on a "next corner"). Those are treated like a
 * missing odd: counted in W–L, left out of PnL/ROI. Odds are never invented.
 */
import { isMatchTotalMarket, marketPeriodMatches } from './oddsMarkets'
import type { CornerHalf, Market, MatchTally } from './types'

export const FLAT_STAKE = 1

export type TipOddIssue = 'missing' | 'team-total' | 'wrong-period' | 'wrong-line'

export const TIP_ODD_ISSUE_LABELS: Record<TipOddIssue, string> = {
  missing: 'sem odd',
  'team-total': 'odd de total de equipa',
  'wrong-period': 'odd de outra parte',
  'wrong-line': 'odd de outra linha',
}

type TipLike = {
  market: Market
  half: CornerHalf
  odd: number | null | undefined
  line: number | null
  status: string
  source?: string
  sourceLabel?: string
  void?: boolean
  goalsTally?: MatchTally
  cornersTally?: MatchTally
  scores?: { home: number; away: number }
}

/** pnl of one 1u bet; null while open/unknown or without an odd. */
export function flatStakePnl(odd: number | null | undefined, status: string): number | null {
  const s = status.toLowerCase()
  if (s === 'push' || s === 'void' || s === 'cancelled' || s === 'canceled' || s === 'refund') return 0
  const valid = typeof odd === 'number' && Number.isFinite(odd) && odd > 1
  if (!valid) return null
  if (s === 'won') return (odd - 1) * FLAT_STAKE
  if (s === 'lost') return -FLAT_STAKE
  if (s === 'half_won' || s === 'half-won' || s === 'halfwon') return ((odd - 1) / 2) * FLAT_STAKE
  if (s === 'half_lost' || s === 'half-lost' || s === 'halflost') return -FLAT_STAKE / 2
  return null
}

/** Settled for W–L / ROI purposes (push/void/cancelled/open excluded). */
export function isDecidedStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'won' || s === 'lost' || s.startsWith('half')
}

export function isWinStatus(status: string): boolean {
  const s = status.toLowerCase()
  return s === 'won' || s === 'half_won' || s === 'half-won' || s === 'halfwon'
}

/** SuperScore market name out of `SuperScore · <market> · …`, else null. */
export function superScoreMarketOf(sourceLabel: string | undefined): string | null {
  if (!sourceLabel) return null
  const parts = sourceLabel.split(' · ')
  const i = parts.findIndex((p) => p.trim() === 'SuperScore')
  if (i < 0 || !parts[i + 1]) return null
  return parts[i + 1].trim()
}

/** null = the odd is the price of this tip's bet; else why it is not. */
export function tipOddIssue(tip: TipLike): TipOddIssue | null {
  if (!(typeof tip.odd === 'number' && Number.isFinite(tip.odd) && tip.odd > 1)) return 'missing'
  if (tip.source === 'superscore') {
    const name = superScoreMarketOf(tip.sourceLabel)
    if (name) {
      if (!isMatchTotalMarket(name, tip.market, 'limit')) return 'team-total'
      if (!marketPeriodMatches(name, tip.half)) return 'wrong-period'
    }
  }
  const tally =
    tip.market === 'corners' ? tip.cornersTally : (tip.goalsTally ?? tip.scores)
  if (tally && tip.line !== null && Number.isFinite(tip.line)) {
    const want = Math.max(0, (tally.home ?? 0) + (tally.away ?? 0)) + 0.5
    if (Math.abs(tip.line - want) > 1e-6) return 'wrong-line'
  }
  return null
}

/** Flat-stake pnl of a tip: null when open, VOID, or without a valid odd. */
export function tipFlatPnl(tip: TipLike): number | null {
  if (tip.void) return null
  if (!isDecidedStatus(tip.status)) return tip.status === 'open' ? null : flatStakePnl(null, tip.status)
  if (tipOddIssue(tip)) return null
  return flatStakePnl(tip.odd, tip.status)
}

export type FlatAgg = {
  tips: number
  open: number
  won: number
  lost: number
  /** Settled with a valid odd = units staked (ROI denominator). */
  priced: number
  /** Settled without a valid odd (in W–L, out of PnL/ROI). */
  noOdd: number
  pnl: number
  roi: number | null
}

export function emptyFlatAgg(): FlatAgg {
  return { tips: 0, open: 0, won: 0, lost: 0, priced: 0, noOdd: 0, pnl: 0, roi: null }
}

/** Adds one (non-VOID) tip to the aggregate; call finishFlatAgg at the end. */
export function addToFlatAgg(agg: FlatAgg, tip: TipLike): void {
  if (tip.void) return
  agg.tips += 1
  if (tip.status === 'open') {
    agg.open += 1
    return
  }
  if (!isDecidedStatus(tip.status)) return // push/void/cancelled: 0, not settled
  if (isWinStatus(tip.status)) agg.won += 1
  else agg.lost += 1
  const pnl = tipFlatPnl(tip)
  if (pnl === null) {
    agg.noOdd += 1
    return
  }
  agg.priced += 1
  agg.pnl += pnl
}

export function finishFlatAgg<T extends FlatAgg>(agg: T): T {
  agg.pnl = Math.round(agg.pnl * 1e6) / 1e6
  agg.roi = agg.priced ? agg.pnl / (agg.priced * FLAT_STAKE) : null
  return agg
}
