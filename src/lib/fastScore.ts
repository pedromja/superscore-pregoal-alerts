import { MARKET_EVENT_TYPE } from './market'
import { MIN_NOTIFY_LEAD_MIN } from './notifyLead'
import {
  matchSokkerProFixtureOriented,
  type SokkerProFixture,
} from './sokkerpro'
import { tallyEvents } from './tally'
import type { FeedAlert, Fixture, GoalEvent, Market, MomentumPayload } from './types'

/**
 * Fast live-score overlay from the SokkerPro mini board (already warmed for
 * odds). **Golos only** — the mini payload has no corner counts.
 *
 * Cantos still depend on SuperScore `type=14` events (same-minute / lead&lt;1
 * plus a latest-tally check on the momentum snapshot).
 */
export const FAST_SCORE_SOURCE = 'sokkerpro' as const

export type FastScore = {
  home: number
  away: number
  minute: number | null
  status: string
  isGoal?: string
  isGoalTeam?: 'home' | 'away'
  source: 'sokkerpro'
}

export type AlreadyHitReason =
  | 'already-hit-fast-score'
  | 'already-hit-is-goal'
  | 'already-hit-corner-tally'

export function isRecentGoalFlag(isGoal?: string | null): boolean {
  return Boolean(isGoal && String(isGoal).trim())
}

export function fastScoreFromMatch(
  fixture: SokkerProFixture,
  swapped: boolean,
): FastScore | null {
  const local = fixture.scoresLocalTeam
  const visitor = fixture.scoresVisitorTeam
  if (local == null || visitor == null) return null
  const home = swapped ? visitor : local
  const away = swapped ? local : visitor
  let isGoalTeam = fixture.isGoalTeam
  if (swapped && isGoalTeam) {
    isGoalTeam = isGoalTeam === 'home' ? 'away' : 'home'
  }
  return {
    home,
    away,
    minute: fixture.minute,
    status: fixture.status,
    ...(fixture.isGoal ? { isGoal: fixture.isGoal } : {}),
    ...(isGoalTeam ? { isGoalTeam } : {}),
    source: FAST_SCORE_SOURCE,
  }
}

/** In-memory: SuperScore fixture → SokkerPro live row (no HTTP). */
export function fastScoreFromBoard(
  fixtures: SokkerProFixture[],
  fixture: Pick<Fixture, 'team1' | 'team2' | 'dateSeconds'>,
): FastScore | null {
  if (!fixtures.length) return null
  const matched = matchSokkerProFixtureOriented(
    fixtures,
    fixture.team1,
    fixture.team2,
    fixture.dateSeconds || null,
  )
  if (!matched) return null
  return fastScoreFromMatch(matched.fixture, matched.swapped)
}

export function superscoreGoalTotal(
  alert: Pick<FeedAlert, 'goalsTally' | 'min' | 'period'>,
  events?: Array<Pick<GoalEvent, 'min' | 'period'>>,
): number {
  if (alert.goalsTally) return alert.goalsTally.home + alert.goalsTally.away
  if (!events?.length) return 0
  return events.filter(
    (event) =>
      event.period < alert.period ||
      (event.period === alert.period && event.min <= alert.min),
  ).length
}

export function superscoreCornerTotal(
  alert: Pick<FeedAlert, 'cornersTally'>,
): number {
  if (!alert.cornersTally) return 0
  return alert.cornersTally.home + alert.cornersTally.away
}

/** All type=14 events in the snapshot (not clipped to the alert minute). */
export function latestCornerTotal(payload: MomentumPayload): number {
  const tally = tallyEvents(payload, MARKET_EVENT_TYPE.corners, {
    min: 10_000,
    period: 99,
  })
  return tally.home + tally.away
}

/**
 * `is_goal` is a "goal just fired" flag. We only let the alert through when
 * SokkerPro's clock is at least `minLead` after the spike. No clock → suppress
 * (Pedro prefers fewer late signals).
 */
export function provenLeadOnFastGoal(
  alertMin: number,
  fastMinute: number | null | undefined,
  minLeadExclusive: number = MIN_NOTIFY_LEAD_MIN,
): boolean {
  if (fastMinute == null || !Number.isFinite(fastMinute)) return false
  return fastMinute - alertMin >= minLeadExclusive
}

export function goalAlreadyHitReason(args: {
  ssGoals: number
  fast: FastScore | null
  alertMin: number
  minLeadExclusive?: number
}): AlreadyHitReason | null {
  const fast = args.fast
  if (!fast) return null
  if (fast.home + fast.away > args.ssGoals) return 'already-hit-fast-score'
  if (!isRecentGoalFlag(fast.isGoal)) return null
  const minLead = args.minLeadExclusive ?? MIN_NOTIFY_LEAD_MIN
  if (!provenLeadOnFastGoal(args.alertMin, fast.minute, minLead)) {
    return 'already-hit-is-goal'
  }
  return null
}

export function cornerAlreadyHitReason(args: {
  alertCorners: number
  latestCorners: number
}): AlreadyHitReason | null {
  if (args.latestCorners > args.alertCorners) return 'already-hit-corner-tally'
  return null
}

/**
 * After min-lead / coincident suppress. SokkerPro unavailable → `null`
 * (fall through; do not block the alert).
 */
export function alreadyHitSuppressReason(args: {
  market: Market
  alert: Pick<
    FeedAlert,
    'min' | 'period' | 'goalsTally' | 'cornersTally' | 'market'
  >
  events?: Array<Pick<GoalEvent, 'min' | 'period'>>
  fast: FastScore | null
  latestCorners?: number | null
  minLeadExclusive?: number
}): AlreadyHitReason | null {
  const market = args.alert.market ?? args.market
  if (market === 'corners') {
    if (args.latestCorners == null) return null
    return cornerAlreadyHitReason({
      alertCorners: superscoreCornerTotal(args.alert),
      latestCorners: args.latestCorners,
    })
  }
  return goalAlreadyHitReason({
    ssGoals: superscoreGoalTotal(args.alert, args.events),
    fast: args.fast,
    alertMin: args.alert.min,
    minLeadExclusive: args.minLeadExclusive,
  })
}
