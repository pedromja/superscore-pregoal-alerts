/** Pure bet decisions for stored alerts / tips from a match snapshot (no store I/O). */
import { computeBetOutcome, isBetDecided, type BetDecision } from '../src/lib/betOutcome.ts'
import { parseMarket } from '../src/lib/market.ts'
import { tipPnl, type Tip } from '../src/lib/tips.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { parseCornerHalf } from '../src/lib/windows.ts'
import type { LoggedAlert, StoredMatch } from './types.ts'

export function matchFinished(match: StoredMatch): boolean {
  return Boolean(match.finished || match.fixture.state === 2 || match.fixture.status >= 100)
}

export function decideBetForMatch(
  args: {
    market: Market
    half: CornerHalf | null | undefined
    minute: number
    period: number
    baseline?: number | null
  },
  match: StoredMatch | null,
  nowMs = Date.now(),
): BetDecision | null {
  if (!match) return null
  const updated = Date.parse(match.updatedAt)
  return computeBetOutcome({
    market: args.market,
    half: args.half,
    alertMin: args.minute,
    alertPeriod: args.period,
    baseline: args.baseline ?? null,
    events: match.payload?.events ?? [],
    points: (match.payload?.timeline ?? []).map((row) => ({ min: row.min, period: row.period })),
    finished: matchFinished(match),
    updatedAtMs: Number.isFinite(updated) ? updated : null,
    kickoffMs: match.fixture.dateSeconds ? match.fixture.dateSeconds * 1000 : null,
    nowMs,
  })
}

export function decideBetForAlert(
  alert: LoggedAlert,
  match: StoredMatch | null,
  scope: { market: Market; half: CornerHalf },
  nowMs = Date.now(),
): BetDecision | null {
  return decideBetForMatch(
    {
      market: parseMarket(alert.market ?? scope.market),
      half: parseCornerHalf(alert.cornerHalf ?? scope.half),
      minute: alert.minute,
      period: alert.period,
      baseline: alert.sendSnapshot?.totalAtAlert ?? null,
    },
    match,
    nowMs,
  )
}

function tipBaseline(tip: Tip): number | null {
  const tally = parseMarket(tip.market) === 'corners' ? tip.cornersTally : tip.goalsTally
  return tally ? tally.home + tally.away : null
}

export function applyBetToTip(tip: Tip, decision: BetDecision | null, nowIso: string): Tip | null {
  if (!decision || !isBetDecided(decision)) return null
  const status = decision.status === 'green' ? ('won' as const) : ('lost' as const)
  if (tip.betOutcome && tip.status === status) return null
  return {
    ...tip,
    betOutcome: decision,
    status,
    pnl: tipPnl(tip.odd, status),
    settledAt: tip.status === status && tip.settledAt ? tip.settledAt : nowIso,
    ...(tip.status !== 'open' && tip.status !== status ? { legacyStatus: tip.legacyStatus ?? tip.status } : {}),
  }
}

export function decideBetForTip(tip: Tip, match: StoredMatch | null, nowMs = Date.now()): BetDecision | null {
  return decideBetForMatch(
    { market: tip.market, half: tip.half, minute: tip.minute, period: tip.period, baseline: tipBaseline(tip) },
    match,
    nowMs,
  )
}

