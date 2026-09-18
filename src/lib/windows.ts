import type { CornerHalf, Market } from './types'

export type CornerWindow = {
  half: CornerHalf
  period: 1 | 2
  from: number
  to: number
  shortHorizon: number
  label: string
  shortLabel: string
}

export type GoalWindow = {
  half: CornerHalf
  period: 1 | 2
  from: number
  to: number
  label: string
  shortLabel: string
}

/** HT 32–42 and FT 82–87 on the absolute SuperScore match clock. */
export const CORNER_WINDOWS: Record<CornerHalf, CornerWindow> = {
  ht: {
    half: 'ht',
    period: 1,
    from: 32,
    to: 42,
    shortHorizon: 5,
    label: '1.ª parte · 32–42',
    shortLabel: 'HT 32–42',
  },
  ft: {
    half: 'ft',
    period: 2,
    from: 82,
    to: 87,
    shortHorizon: 3,
    label: '2.ª parte · 82–87',
    shortLabel: 'FT 82–87',
  },
}

/**
 * HT 20–42 and FT 70–90 on the absolute SuperScore match clock.
 * Stoppage (P1>45 / P2>90) is hard-banned even if a bound were widened.
 */
export const GOAL_WINDOWS: Record<CornerHalf, GoalWindow> = {
  ht: {
    half: 'ht',
    period: 1,
    from: 20,
    to: 42,
    label: '1.ª parte · 20–42',
    shortLabel: 'HT 20–42',
  },
  ft: {
    half: 'ft',
    period: 2,
    from: 70,
    to: 90,
    label: '2.ª parte · 70–90',
    shortLabel: 'FT 70–90',
  },
}

export const CORNER_HALVES: CornerHalf[] = ['ht', 'ft']
export const GOAL_HALVES: CornerHalf[] = ['ht', 'ft']

export function isCornerHalf(value: unknown): value is CornerHalf {
  return value === 'ht' || value === 'ft'
}

export function parseCornerHalf(
  value: unknown,
  fallback: CornerHalf = 'ht',
): CornerHalf {
  return isCornerHalf(value) ? value : fallback
}

export function parseCornerHalfOpt(value: unknown): CornerHalf | undefined {
  return isCornerHalf(value) ? value : undefined
}

/**
 * Injury / extra time on the absolute SuperScore clock.
 * Hard-bans alerts that would fire too late to act (e.g. 96').
 */
export function isStoppageClock(min: number, period: number): boolean {
  if (period === 1 && min > 45) return true
  if (period === 2 && min > 90) return true
  return false
}

function halfInWindows<T extends { period: 1 | 2; from: number; to: number }>(
  min: number,
  period: number,
  windows: Record<CornerHalf, T>,
  halves: CornerHalf[],
): CornerHalf | null {
  if (isStoppageClock(min, period)) return null
  for (const half of halves) {
    const window = windows[half]
    if (period === window.period && min >= window.from && min <= window.to) {
      return half
    }
  }
  return null
}

/**
 * Map an absolute clock minute + period onto Pedro's corner windows.
 * Extra time (P1>45 / P2>90) is outside both windows.
 */
export function cornerHalfOf(
  min: number,
  period: number,
): CornerHalf | null {
  return halfInWindows(min, period, CORNER_WINDOWS, CORNER_HALVES)
}

export function cornerWindowOf(
  min: number,
  period: number,
): CornerWindow | null {
  const half = cornerHalfOf(min, period)
  return half ? CORNER_WINDOWS[half] : null
}

export function inCornerWindow(
  min: number,
  period: number,
  half?: CornerHalf | null,
): boolean {
  if (isStoppageClock(min, period)) return false
  const found = cornerHalfOf(min, period)
  if (!found) return false
  if (!half) return true
  return found === half
}

export function windowForHalf(half: CornerHalf): CornerWindow {
  return CORNER_WINDOWS[half]
}

/**
 * Map an absolute clock minute + period onto Pedro's goal windows.
 * Extra time (P1>45 / P2>90) is hard-banned.
 */
export function goalHalfOf(min: number, period: number): CornerHalf | null {
  return halfInWindows(min, period, GOAL_WINDOWS, GOAL_HALVES)
}

export function goalWindowOf(min: number, period: number): GoalWindow | null {
  const half = goalHalfOf(min, period)
  return half ? GOAL_WINDOWS[half] : null
}

export function inGoalsWindow(
  min: number,
  period: number,
  half?: CornerHalf | null,
): boolean {
  if (isStoppageClock(min, period)) return false
  const found = goalHalfOf(min, period)
  if (!found) return false
  if (!half) return true
  return found === half
}

/** Clock gating shared by evaluate, poller push, and learn ingest. */
export function inMarketClockWindow(
  market: Market,
  min: number,
  period: number,
): boolean {
  if (isStoppageClock(min, period)) return false
  return market === 'corners'
    ? inCornerWindow(min, period)
    : inGoalsWindow(min, period)
}
