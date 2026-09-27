import type { Market } from './types'

export const LEAGUE_TG_MIN_TIPS_AUTO = 8
export const LEAGUE_TG_DEFAULT_MIN_ROI = 0.05

export type LeagueTgMarket = 'goals' | 'corners'

export type LeagueTgGate = {
  tg: boolean
  auto: boolean
  minRoi: number
}

export type LeagueTelegramFile = {
  minTipsAuto: number
  defaultMinRoi: number
  leagues: Record<string, Partial<Record<LeagueTgMarket, LeagueTgGate>>>
}

export const DEFAULT_LEAGUE_TG_GATE: LeagueTgGate = {
  tg: true,
  auto: false,
  minRoi: LEAGUE_TG_DEFAULT_MIN_ROI,
}

export function marketToTg(market: Market | string): LeagueTgMarket {
  return market === 'corners' ? 'corners' : 'goals'
}

export function normalizeMinRoi(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return LEAGUE_TG_DEFAULT_MIN_ROI
  return Math.max(0.0001, n)
}

export function normalizeGate(raw: unknown): LeagueTgGate {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    tg: o.tg !== false,
    auto: o.auto === true,
    minRoi: normalizeMinRoi(o.minRoi ?? LEAGUE_TG_DEFAULT_MIN_ROI),
  }
}

export function normalizeLeagueTelegramFile(raw: unknown): LeagueTelegramFile {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const leaguesIn =
    o.leagues && typeof o.leagues === 'object'
      ? (o.leagues as Record<string, unknown>)
      : {}
  const leagues: LeagueTelegramFile['leagues'] = {}
  for (const [key, val] of Object.entries(leaguesIn)) {
    const row = val && typeof val === 'object' ? (val as Record<string, unknown>) : {}
    leagues[key] = {
      goals: normalizeGate(row.goals),
      corners: normalizeGate(row.corners),
    }
  }
  const minTips =
    typeof o.minTipsAuto === 'number' && o.minTipsAuto >= 1
      ? Math.floor(o.minTipsAuto)
      : LEAGUE_TG_MIN_TIPS_AUTO
  return {
    minTipsAuto: minTips,
    defaultMinRoi: normalizeMinRoi(o.defaultMinRoi ?? LEAGUE_TG_DEFAULT_MIN_ROI),
    leagues,
  }
}

/**
 * Telegram only. Never used to skip tip creation.
 * AUTO: send iff settled >= minTips and roi >= minRoi.
 * Manual: send iff tg === true.
 */
export function shouldSendTelegramLeague(args: {
  gate: LeagueTgGate
  settled: number
  roi: number | null
  minTipsAuto: number
}): boolean {
  if (args.gate.auto) {
    if (args.settled < args.minTipsAuto) return false
    if (args.roi === null) return false
    return args.roi >= args.gate.minRoi
  }
  return args.gate.tg
}
