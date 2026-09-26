import type { CornerHalf, Market } from './types'
import {
  snapshotFromSokkerProPick,
  SOKKERPRO_SOURCE,
  SOKKERPRO_SOURCE_LABEL,
  type SokkerProPick,
} from './sokkerpro'
import { entryTypeOf, type EntryType, type TipSource } from './tips'
import { isMatchTotalMarket, marketPeriodMatches } from './oddsMarkets'

export type OddsPriceSide = 'over' | 'under' | 'home' | 'away' | 'other'

export type OddsPrice = {
  name: string
  price: number
  line: number | null
  side: OddsPriceSide
}

export type OddsSnapshot = {
  kind: 'limit' | 'asian'
  marketName: string
  line: number | null
  prices: OddsPrice[]
}

export type OddsSource = 'superscore' | 'sokkerpro' | 'robobet' | 'mixed' | 'none'

export type OddsObservation = {
  ts: string
  fixtureId: string
  matchLabel: string
  league: string
  market: Market
  half: CornerHalf
  bucket: EntryType
  minute: number
  period: number
  alertId: string
  currentTotal: number
  source: OddsSource
  sourceLabel: string
  limit: OddsSnapshot | null
  asian: OddsSnapshot | null
  sokkerpro?: SokkerProPick | null
  robobet: { odd: number; line: number | null } | null
}

export type MaisUmPrice = {
  odd: number
  line: number | null
  source: TipSource
}

export function oddsLogKey(
  market: Market,
  half: CornerHalf,
  league: string,
): string {
  const liga = league.trim() || 'Sem liga'
  return `${market}|${half}|${liga}`
}

export function isSokkerProSnapshot(snap: OddsSnapshot | null | undefined): boolean {
  return Boolean(snap && /sokkerpro/i.test(snap.marketName))
}

export function isRobobetSnapshot(snap: OddsSnapshot | null | undefined): boolean {
  return Boolean(snap && /odd ao vivo|robobet/i.test(snap.marketName))
}

function ssLimitOf(obs: OddsObservation): OddsSnapshot | null {
  if (!obs.limit || isSokkerProSnapshot(obs.limit) || isRobobetSnapshot(obs.limit)) {
    return null
  }
  return obs.limit
}

/** The "+0.5" line of the alert: current market total + 0.5. */
export function maisUmWantedLine(obs: Pick<OddsObservation, 'currentTotal'>): number | null {
  return Number.isFinite(obs.currentTotal) ? Math.max(0, obs.currentTotal) + 0.5 : null
}

function sameLine(a: number | null | undefined, b: number | null): boolean {
  return a != null && b != null && Math.abs(a - b) < 1e-6
}

/**
 * SuperScore snapshot is the match total of the alert's market for the alert's
 * period (HT → 1st-half market, FT → full match). Also re-checks observations
 * stored before the strict picker (team totals, other periods, alt lines).
 */
export function ssSnapshotValid(obs: OddsObservation, snap: OddsSnapshot | null | undefined, kind: 'limit' | 'asian'): boolean {
  if (!snap) return false
  return isMatchTotalMarket(snap.marketName, obs.market, kind) && marketPeriodMatches(snap.marketName, obs.half)
}

/**
 * The over price of exactly "one more event" for the alert's period
 * (SuperScore → SokkerPro → RoboBet). Anything else — another line, another
 * period, a team total, a pre-match price — returns null (no odd shown).
 */
export function maisUmPriceOf(obs: OddsObservation | null | undefined): MaisUmPrice | null {
  if (!obs) return null
  const want = maisUmWantedLine(obs)
  if (want == null) return null
  const ss = ssLimitOf(obs)
  const ssOver = ssSnapshotValid(obs, ss, 'limit')
    ? ss?.prices.find((p) => p.side === 'over' && p.price > 1 && sameLine(p.line, want))
    : null
  if (ssOver) {
    return { odd: ssOver.price, line: want, source: 'superscore' }
  }
  const spro = obs.sokkerpro
  if (spro && spro.odd > 1 && spro.period === obs.half && spro.live !== false && sameLine(spro.line, want)) {
    return { odd: spro.odd, line: want, source: SOKKERPRO_SOURCE }
  }
  if (obs.robobet?.odd && obs.robobet.odd > 1 && sameLine(obs.robobet.line, want)) {
    return { odd: obs.robobet.odd, line: want, source: 'robobet' }
  }
  return null
}

/** Asian total pair for the alert's period (over/under just above the current total). */
export function asianPricesOf(obs: OddsObservation | null | undefined): OddsPrice[] {
  if (!obs?.asian || !ssSnapshotValid(obs, obs.asian, 'asian')) return []
  const total = obs.currentTotal
  if (!Number.isFinite(total)) return []
  return obs.asian.prices.filter(
    (p) =>
      p.price > 1 &&
      (p.side === 'over' || p.side === 'under') &&
      p.line != null &&
      p.line > total &&
      p.line <= total + 1 + 1e-6,
  )
}

export function formatObservationLine(obs: OddsObservation | null | undefined): string | null {
  if (!obs) return null
  const bits: string[] = []
  if (obs.limit?.prices.length) {
    const compact = obs.limit.prices
      .map((p) => `${p.side === 'over' ? 'O' : p.side === 'under' ? 'U' : p.name} ${p.price.toFixed(2)}`)
      .join(' / ')
    bits.push(`Limite ${obs.limit.line ?? ''} ${compact}`.replace(/\s+/g, ' ').trim())
  }
  if (obs.asian?.prices.length) {
    const compact = obs.asian.prices
      .slice(0, 4)
      .map((p) => `${p.name} ${p.price.toFixed(2)}`)
      .join(' · ')
    bits.push(`Asiático ${compact}`)
  }
  if (obs.sokkerpro && obs.sokkerpro.odd > 1 && !bits.some((b) => /SokkerPro/i.test(b))) {
    bits.push(SOKKERPRO_SOURCE_LABEL)
  }
  if (!bits.length && obs.robobet) {
    bits.push(`RoboBet ${obs.robobet.odd.toFixed(2)}`)
  }
  return bits.length ? bits.join(' · ') : null
}

export function emptyObservation(partial: Omit<OddsObservation, 'source' | 'sourceLabel' | 'limit' | 'asian' | 'robobet' | 'sokkerpro' | 'bucket'> & {
  bucket?: EntryType
}): OddsObservation {
  return {
    ...partial,
    bucket: partial.bucket ?? entryTypeOf(partial.market, partial.half),
    source: 'none',
    sourceLabel: 'sem odd observada',
    limit: null,
    asian: null,
    sokkerpro: null,
    robobet: null,
  }
}

function robobetSnapshot(robobet: { odd: number; line: number | null }, marketRaw?: string): OddsSnapshot {
  return {
    kind: 'limit',
    marketName: marketRaw || 'Odd Ao Vivo',
    line: robobet.line,
    prices: [
      {
        name: 'Odd Ao Vivo',
        price: robobet.odd,
        line: robobet.line,
        side: 'over',
      },
    ],
  }
}

export function composeOddsObservation(args: {
  partial: Parameters<typeof emptyObservation>[0]
  limit: OddsSnapshot | null
  asian: OddsSnapshot | null
  sokkerpro: SokkerProPick | null
  robobet: { odd: number; line: number | null } | null
  robobetMarketRaw?: string | null
}): OddsObservation {
  const ssLimit =
    args.limit && !isSokkerProSnapshot(args.limit) && !isRobobetSnapshot(args.limit)
      ? args.limit
      : null
  const ssOver = ssLimit?.prices.some((p) => p.side === 'over' && p.price > 1) ?? false
  const spro = ssOver ? null : args.sokkerpro
  let limit = ssLimit
  if (!limit && spro) limit = snapshotFromSokkerProPick(spro)
  if (!limit && args.robobet && args.robobet.odd > 1) {
    limit = robobetSnapshot(args.robobet, args.robobetMarketRaw ?? undefined)
  }

  const labels: string[] = []
  if (ssLimit) labels.push(`SuperScore · ${ssLimit.marketName}`)
  if (args.asian) labels.push(`Asiático · ${args.asian.marketName}`)
  if (spro) {
    const line = String(spro.line).replace('.', ',')
    labels.push(`${SOKKERPRO_SOURCE_LABEL} · Over ${line}`)
  }
  if (args.robobet && args.robobet.odd > 1) labels.push('RoboBet · Odd Ao Vivo')

  const kinds: OddsSource[] = []
  if (ssLimit || args.asian) kinds.push('superscore')
  if (spro) kinds.push(SOKKERPRO_SOURCE)
  if (args.robobet && args.robobet.odd > 1) kinds.push('robobet')

  const source: OddsSource =
    kinds.length === 0 ? 'none' : kinds.length > 1 ? 'mixed' : kinds[0]
  const sourceLabel = labels.length ? labels.join(' · ') : 'sem odd observada'

  return {
    ...emptyObservation(args.partial),
    source,
    sourceLabel,
    limit,
    asian: args.asian,
    sokkerpro: spro,
    robobet: args.robobet && args.robobet.odd > 1 ? args.robobet : null,
  }
}
