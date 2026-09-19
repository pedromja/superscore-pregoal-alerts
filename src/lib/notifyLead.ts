import { MIN_LEAD_MIN } from './horizons'
import type { GoalEvent, Side } from './types'

/**
 * Live notify floor. Matches locked backtest: a tip needs ≥1′ of clock
 * before the market event. Env `MIN_NOTIFY_LEAD_MIN` may override on the server.
 */
export const MIN_NOTIFY_LEAD_MIN = MIN_LEAD_MIN

export type NotifySuppressReason =
  | 'coincident-same-min'
  | 'lead-lt-1'
  | 'goal-at-clock'

export type NotifyLeadAlert = {
  min: number
  period: number
  index: number
  side: Side
  coincident?: boolean
}

export type NotifyLeadEvent = Pick<GoalEvent, 'min' | 'period' | 'index' | 'side'>

export type NotifyLeadClock = {
  min: number
  period: number
}

export function parseMinNotifyLeadMin(raw: string | undefined): number {
  if (raw == null || raw.trim() === '') return MIN_NOTIFY_LEAD_MIN
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 0) return MIN_NOTIFY_LEAD_MIN
  return n
}

function eventAtOrAfterAlert(
  event: NotifyLeadEvent,
  alert: NotifyLeadAlert,
): boolean {
  if (event.period !== alert.period) return event.period > alert.period
  return event.min >= alert.min || event.index >= alert.index
}

function clockLeadMin(
  event: NotifyLeadEvent,
  alert: NotifyLeadAlert,
): number | null {
  if (event.period < alert.period) return null
  return event.min - alert.min
}

function sameClockMinute(
  event: NotifyLeadEvent,
  alert: NotifyLeadAlert,
): boolean {
  return event.period === alert.period && event.min === alert.min
}

/**
 * Why a live push (Telegram / web push / browser) must not fire.
 * Evaluate/learning still records the raw alert.
 *
 * - same period + same `min` as any market event → `coincident-same-min`
 * - index or clock lead in `[0, minLeadExclusive)` → `lead-lt-1`
 * - market event already at the latest momentum minute for this side → `goal-at-clock`
 */
export function notifySuppressReason(
  alert: NotifyLeadAlert,
  events: NotifyLeadEvent[],
  clock?: NotifyLeadClock | null,
  minLeadExclusive: number = MIN_NOTIFY_LEAD_MIN,
): NotifySuppressReason | null {
  const nearby = events.filter((event) => eventAtOrAfterAlert(event, alert))

  for (const event of nearby) {
    if (sameClockMinute(event, alert)) return 'coincident-same-min'
  }

  if (alert.coincident) return 'coincident-same-min'

  for (const event of nearby) {
    const indexLead = event.index - alert.index
    if (indexLead >= 0 && indexLead < minLeadExclusive) return 'lead-lt-1'
    const lead = clockLeadMin(event, alert)
    if (lead !== null && lead >= 0 && lead < minLeadExclusive) return 'lead-lt-1'
  }

  if (clock) {
    const atClock = events.some(
      (event) =>
        event.period === clock.period &&
        event.min === clock.min &&
        event.side === alert.side,
    )
    if (atClock) return 'goal-at-clock'
  }

  return null
}
