import { ENTRY_ORDER, type EntryType } from './tips'

export type { EntryType }

export type TipOverlayBucket = {
  enable: boolean
  minOdd: number | null
  maxOdd: number | null
}

export type TipOverlay = {
  requireOdd: boolean
  minOdd: number | null
  maxOdd: number | null
  buckets: Record<EntryType, TipOverlayBucket>
}

export type TipOverlayProposal = {
  id: string
  ts: string
  reason: string
  applied: boolean
  overlay: TipOverlay
  note: string
}

export type OverlayDecision = {
  ok: boolean
  reason: string
  permanent: boolean
  bucket: EntryType
  minOdd: number | null
  maxOdd: number | null
}

/**
 * Overlay on top of existing Spike/Swing/Sustained rules.
 * min/max stay null until Pedro confirms backtest cutoffs — do not invent them.
 */
export const DEFAULT_TIP_OVERLAY: TipOverlay = {
  requireOdd: true,
  minOdd: null,
  maxOdd: null,
  buckets: {
    goals_ht: { enable: true, minOdd: null, maxOdd: null },
    goals_ft: { enable: true, minOdd: null, maxOdd: null },
    corners_ht: { enable: true, minOdd: null, maxOdd: null },
    corners_ft: { enable: true, minOdd: null, maxOdd: null },
  },
}

export const OVERLAY_NOTE =
  'Overlay de odd separado de params*.json. Regras Spike/Swing/Sustained não mudam sem confirmação. minOdd/maxOdd null até Pedro confirmar o backtest.'

function asFiniteOdd(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'number' ? value : Number(String(value).replace(',', '.'))
  if (!Number.isFinite(n) || n <= 1) return null
  return n
}

function asBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  return fallback
}

function parseBucket(
  raw: unknown,
  fallback: TipOverlayBucket,
): TipOverlayBucket {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    enable: asBool(obj.enable, fallback.enable),
    minOdd: asFiniteOdd(obj.minOdd),
    maxOdd: asFiniteOdd(obj.maxOdd),
  }
}

export function normalizeTipOverlay(raw: unknown): TipOverlay {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const bucketsRaw =
    obj.buckets && typeof obj.buckets === 'object'
      ? (obj.buckets as Record<string, unknown>)
      : obj
  const buckets = { ...DEFAULT_TIP_OVERLAY.buckets }
  for (const key of ENTRY_ORDER) {
    buckets[key] = parseBucket(bucketsRaw[key], DEFAULT_TIP_OVERLAY.buckets[key])
  }
  return {
    requireOdd: asBool(obj.requireOdd, true),
    minOdd: asFiniteOdd(obj.minOdd),
    maxOdd: asFiniteOdd(obj.maxOdd),
    buckets,
  }
}

export function overlayBounds(
  overlay: TipOverlay,
  bucket: EntryType,
): { minOdd: number | null; maxOdd: number | null } {
  const row = overlay.buckets[bucket] ?? DEFAULT_TIP_OVERLAY.buckets[bucket]
  return {
    minOdd: row.minOdd ?? overlay.minOdd,
    maxOdd: row.maxOdd ?? overlay.maxOdd,
  }
}

export function oddPassesOverlay(
  overlay: TipOverlay,
  bucket: EntryType,
  odd: number | null,
): OverlayDecision {
  const row = overlay.buckets[bucket] ?? DEFAULT_TIP_OVERLAY.buckets[bucket]
  const { minOdd, maxOdd } = overlayBounds(overlay, bucket)
  if (!row.enable) {
    return {
      ok: false,
      reason: `bucket ${bucket} desligado no overlay`,
      permanent: true,
      bucket,
      minOdd,
      maxOdd,
    }
  }
  if (odd === null || !(odd > 1)) {
    if (overlay.requireOdd) {
      return {
        ok: false,
        reason: 'sem odd mais-um válida (requireOdd)',
        permanent: false,
        bucket,
        minOdd,
        maxOdd,
      }
    }
    return { ok: true, reason: 'odd opcional', permanent: false, bucket, minOdd, maxOdd }
  }
  if (minOdd !== null && odd < minOdd) {
    return {
      ok: false,
      reason: `odd ${odd} < minOdd ${minOdd} (${bucket})`,
      permanent: false,
      bucket,
      minOdd,
      maxOdd,
    }
  }
  if (maxOdd !== null && odd > maxOdd) {
    return {
      ok: false,
      reason: `odd ${odd} > maxOdd ${maxOdd} (${bucket})`,
      permanent: false,
      bucket,
      minOdd,
      maxOdd,
    }
  }
  return {
    ok: true,
    reason: 'overlay ok',
    permanent: false,
    bucket,
    minOdd,
    maxOdd,
  }
}
