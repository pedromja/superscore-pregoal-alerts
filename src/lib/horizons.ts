import type { CornerHalf, GoalEvent, Market, Side, TimelinePoint } from './types'
import { CORNER_WINDOWS, GOAL_WINDOWS, cornerHalfOf, goalHalfOf } from './windows'

export const HORIZON_SHORT = 5
export const HORIZON_LONG_CAP = 15
/** Hard floor: never credit lead 0 / post-event. 1' is the first usable minute. */
export const MIN_LEAD_MIN = 1
/** Preferred actionable band on the absolute SuperScore clock. */
export const PREFERRED_LEAD_MAX = 2

export type HorizonOutcome = {
  hit5: boolean | null
  hitLong: boolean | null
  longDeadline: number
  leadTime5: number | null
  leadTimeLong: number | null
}

export type HorizonOptions = {
  shortHorizon?: number
  deadlineCap?: number
  sameWindowOnly?: boolean
  halfOf?: (min: number, period: number) => CornerHalf | null
  minLead?: number
}

export function periodEndMin(
  points: Pick<TimelinePoint, 'period' | 'min'>[],
  period: number,
): number {
  const same = points.filter((p) => p.period === period)
  if (same.length) return Math.max(...same.map((p) => p.min))
  return period <= 1 ? 45 : 90
}

export function longDeadlineMin(
  alertMin: number,
  period: number,
  points: Pick<TimelinePoint, 'period' | 'min'>[],
  deadlineCap?: number,
): number {
  const raw = Math.min(alertMin + HORIZON_LONG_CAP, periodEndMin(points, period))
  return deadlineCap === undefined ? raw : Math.min(raw, deadlineCap)
}

export function isUsableLead(lead: number | null | undefined): lead is number {
  return typeof lead === 'number' && lead >= MIN_LEAD_MIN
}

export function isPreferredLead(lead: number | null | undefined): boolean {
  return isUsableLead(lead) && lead <= PREFERRED_LEAD_MAX
}

function isAfterAlert(
  goal: Pick<GoalEvent, 'min' | 'period'>,
  alertMin: number,
  alertPeriod: number,
): boolean {
  if (goal.period !== alertPeriod) return goal.period > alertPeriod
  return goal.min > alertMin
}

function nearestLead(
  goals: GoalEvent[],
  side: Side,
  alertMin: number,
  alertPeriod: number,
  deadlineMin: number,
  samePeriodOnly: boolean,
  options: HorizonOptions,
): number | null {
  const minLead = options.minLead ?? MIN_LEAD_MIN
  const halfOf = options.halfOf ?? cornerHalfOf
  const alertHalf = options.sameWindowOnly ? halfOf(alertMin, alertPeriod) : null
  let best: number | null = null
  for (const goal of goals) {
    if (goal.side !== side) continue
    if (!isAfterAlert(goal, alertMin, alertPeriod)) continue
    if (samePeriodOnly && goal.period !== alertPeriod) continue
    if (goal.min > deadlineMin) continue
    if (options.sameWindowOnly) {
      const goalHalf = halfOf(goal.min, goal.period)
      if (!alertHalf || goalHalf !== alertHalf) continue
    }
    const lead = goal.min - alertMin
    if (lead < minLead) continue
    if (best === null || lead < best) best = lead
  }
  return best
}

export function horizonOptionsForHalf(half?: CornerHalf | null): HorizonOptions {
  if (!half) return { minLead: MIN_LEAD_MIN }
  const window = CORNER_WINDOWS[half]
  return {
    shortHorizon: window.shortHorizon,
    deadlineCap: window.to,
    sameWindowOnly: true,
    halfOf: cornerHalfOf,
    minLead: MIN_LEAD_MIN,
  }
}

export function horizonOptionsForMarket(
  market: Market,
  half?: CornerHalf | null,
): HorizonOptions {
  if (market === 'corners') return horizonOptionsForHalf(half)
  if (!half) return { minLead: MIN_LEAD_MIN, halfOf: goalHalfOf, sameWindowOnly: true }
  const window = GOAL_WINDOWS[half]
  return {
    shortHorizon: HORIZON_SHORT,
    deadlineCap: window.to,
    sameWindowOnly: true,
    halfOf: goalHalfOf,
    minLead: MIN_LEAD_MIN,
  }
}

export function outcomeForAlert(
  alert: { min: number; period: number; side: Side; coincident?: boolean },
  goals: GoalEvent[],
  points: Pick<TimelinePoint, 'period' | 'min'>[],
  options: HorizonOptions = {},
): HorizonOutcome {
  const shortHorizon = options.shortHorizon ?? HORIZON_SHORT
  const minLead = options.minLead ?? MIN_LEAD_MIN
  const longDeadline = longDeadlineMin(
    alert.min,
    alert.period,
    points,
    options.deadlineCap,
  )
  const shortDeadline = Math.min(
    alert.min + shortHorizon,
    options.deadlineCap ?? Number.POSITIVE_INFINITY,
  )
  if (alert.coincident) {
    return {
      hit5: false,
      hitLong: false,
      longDeadline,
      leadTime5: 0,
      leadTimeLong: 0,
    }
  }
  const leadTime5 = nearestLead(
    goals,
    alert.side,
    alert.min,
    alert.period,
    shortDeadline,
    false,
    { ...options, minLead },
  )
  const leadTimeLong = nearestLead(
    goals,
    alert.side,
    alert.min,
    alert.period,
    longDeadline,
    true,
    { ...options, minLead },
  )
  return {
    hit5: isUsableLead(leadTime5),
    hitLong: isUsableLead(leadTimeLong),
    longDeadline,
    leadTime5,
    leadTimeLong,
  }
}

export function goalHadPrealert(
  goal: GoalEvent,
  alerts: { min: number; period: number; side: Side; coincident?: boolean }[],
  points: Pick<TimelinePoint, 'period' | 'min'>[],
  mode: 'short' | 'long',
  options: HorizonOptions = {},
): { hit: boolean; lead: number | null } {
  let best: number | null = null
  for (const alert of alerts) {
    if (alert.coincident || alert.side !== goal.side) continue
    const out = outcomeForAlert(alert, [goal], points, options)
    const lead = mode === 'short' ? out.leadTime5 : out.leadTimeLong
    if (!isUsableLead(lead)) continue
    if (best === null || lead < best) best = lead
  }
  return { hit: best !== null, lead: best }
}
