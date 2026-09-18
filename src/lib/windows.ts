import type { CornerHalf } from './types'

export type CornerWindow = {
  half: CornerHalf
  period: 1 | 2
  from: number
  to: number
  shortHorizon: number
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

export const CORNER_HALVES: CornerHalf[] = ['ht', 'ft']

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
 * Map an absolute clock minute + period onto Pedro's corner windows.
 * Extra time (P1>45 / P2>90) is outside both windows.
 */
export function cornerHalfOf(
  min: number,
  period: number,
): CornerHalf | null {
  for (const half of CORNER_HALVES) {
    const window = CORNER_WINDOWS[half]
    if (period === window.period && min >= window.from && min <= window.to) {
      return half
    }
  }
  return null
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
  const found = cornerHalfOf(min, period)
  if (!found) return false
  if (!half) return true
  return found === half
}

export function windowForHalf(half: CornerHalf): CornerWindow {
  return CORNER_WINDOWS[half]
}
