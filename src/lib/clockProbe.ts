import type { FastScore } from './fastScore'
import type { Market, Side } from './types'

/**
 * Snapshot of the fast SokkerPro clock at the moment a SuperScore alert
 * is evaluated / notified. Used for the prospective lead study — historical
 * dumps never had this.
 */
export type AlertClockProbe = {
  ts: string
  source: 'sokkerpro' | null
  matched: boolean
  fast: FastScore | null
  ssGoals: number
  ssCorners: number
  market: Market
}

export type SokkerScoreSnap = {
  home: number
  away: number
  minute: number | null
  status: string
  isGoal?: string
  isGoalTeam?: 'home' | 'away'
}

export type SokkerGoalTransition = {
  kind: 'goal'
  side: Side
  from: { home: number; away: number }
  to: { home: number; away: number }
  sokkerMinute: number | null
  isGoal: string | null
  isGoalTeam: 'home' | 'away' | undefined
}

export type SokkerClockObservation = {
  ts: string
  fixtureId: string
  matchLabel: string
  ssClockMin: number | null
  ssClockPeriod: number | null
  matched: boolean
  fast: SokkerScoreSnap | null
  prevScore: { home: number; away: number } | null
  transition: SokkerGoalTransition | null
}

export function scoreSnapFromFast(fast: FastScore | null): SokkerScoreSnap | null {
  if (!fast) return null
  return {
    home: fast.home,
    away: fast.away,
    minute: fast.minute,
    status: fast.status,
    ...(fast.isGoal ? { isGoal: fast.isGoal } : {}),
    ...(fast.isGoalTeam ? { isGoalTeam: fast.isGoalTeam } : {}),
  }
}

export function goalTransitionOf(
  prev: { home: number; away: number } | null,
  next: { home: number; away: number },
  extra: {
    sokkerMinute: number | null
    isGoal?: string
    isGoalTeam?: 'home' | 'away'
  },
): SokkerGoalTransition | null {
  if (!prev) return null
  const dHome = next.home - prev.home
  const dAway = next.away - prev.away
  if (dHome <= 0 && dAway <= 0) return null
  const side: Side = dHome > dAway ? 'home' : dAway > dHome ? 'away' : extra.isGoalTeam ?? 'home'
  return {
    kind: 'goal',
    side,
    from: prev,
    to: next,
    sokkerMinute: extra.sokkerMinute,
    isGoal: extra.isGoal ?? null,
    isGoalTeam: extra.isGoalTeam,
  }
}

export function alertClockProbe(args: {
  ts?: string
  fast: FastScore | null
  ssGoals: number
  ssCorners: number
  market: Market
}): AlertClockProbe {
  return {
    ts: args.ts ?? new Date().toISOString(),
    source: args.fast ? 'sokkerpro' : null,
    matched: Boolean(args.fast),
    fast: args.fast,
    ssGoals: args.ssGoals,
    ssCorners: args.ssCorners,
    market: args.market,
  }
}
