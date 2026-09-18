import type { CornerHalf, Market } from './types'
import { entryTypeOf, type EntryType } from './tips'

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
  source: 'superscore' | 'robobet' | 'mixed' | 'none'
  sourceLabel: string
  limit: OddsSnapshot | null
  asian: OddsSnapshot | null
  robobet: { odd: number; line: number | null } | null
}

export function oddsLogKey(
  market: Market,
  half: CornerHalf,
  league: string,
): string {
  const liga = league.trim() || 'Sem liga'
  return `${market}|${half}|${liga}`
}

export function maisUmPriceOf(obs: OddsObservation | null | undefined): {
  odd: number
  line: number | null
} | null {
  if (!obs) return null
  const over = obs.limit?.prices.find((p) => p.side === 'over' && p.price > 1)
  if (over) return { odd: over.price, line: over.line ?? obs.limit?.line ?? null }
  if (obs.robobet?.odd && obs.robobet.odd > 1) {
    return { odd: obs.robobet.odd, line: obs.robobet.line }
  }
  return null
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
  if (!bits.length && obs.robobet) {
    bits.push(`RoboBet ${obs.robobet.odd.toFixed(2)}`)
  }
  return bits.length ? bits.join(' · ') : null
}

export function emptyObservation(partial: Omit<OddsObservation, 'source' | 'sourceLabel' | 'limit' | 'asian' | 'robobet' | 'bucket'> & {
  bucket?: EntryType
}): OddsObservation {
  return {
    ...partial,
    bucket: partial.bucket ?? entryTypeOf(partial.market, partial.half),
    source: 'none',
    sourceLabel: 'sem odd observada',
    limit: null,
    asian: null,
    robobet: null,
  }
}
