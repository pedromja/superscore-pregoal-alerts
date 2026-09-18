import type { GoalEvent, Side, TimelinePoint } from './types'

export const HORIZON_SHORT = 5
export const HORIZON_LONG_CAP = 15

export type HorizonOutcome = {
  hit5: boolean | null
  hitLong: boolean | null
  longDeadline: number
  leadTime5: number | null
  leadTimeLong: number | null
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
): number {
  return Math.min(alertMin + HORIZON_LONG_CAP, periodEndMin(points, period))
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
): number | null {
  let best: number | null = null
  for (const goal of goals) {
    if (goal.side !== side) continue
    if (!isAfterAlert(goal, alertMin, alertPeriod)) continue
    if (samePeriodOnly && goal.period !== alertPeriod) continue
    if (goal.min > deadlineMin) continue
    const lead = goal.min - alertMin
    if (lead <= 0) continue
    if (best === null || lead < best) best = lead
  }
  return best
}

export function outcomeForAlert(
  alert: { min: number; period: number; side: Side; coincident?: boolean },
  goals: GoalEvent[],
  points: Pick<TimelinePoint, 'period' | 'min'>[],
): HorizonOutcome {
  const longDeadline = longDeadlineMin(alert.min, alert.period, points)
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
    alert.min + HORIZON_SHORT,
    false,
  )
  const leadTimeLong = nearestLead(
    goals,
    alert.side,
    alert.min,
    alert.period,
    longDeadline,
    true,
  )
  return {
    hit5: leadTime5 !== null,
    hitLong: leadTimeLong !== null,
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
): { hit: boolean; lead: number | null } {
  let best: number | null = null
  for (const alert of alerts) {
    if (alert.coincident || alert.side !== goal.side) continue
    const out = outcomeForAlert(alert, [goal], points)
    const lead = mode === 'short' ? out.leadTime5 : out.leadTimeLong
    if (lead === null) continue
    if (best === null || lead < best) best = lead
  }
  return { hit: best !== null, lead: best }
}
