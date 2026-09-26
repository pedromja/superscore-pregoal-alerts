import type { OddsPrice, OddsSnapshot } from './oddsObserve'
import type { CornerHalf, Market } from './types'

export type SuperbetOdd = {
  uuid?: string
  price?: number
  status?: number
  display?: boolean
  name?: string
  metadata?: {
    name?: string
    outcome_id?: number
    info?: string
    tags?: string
  }
}

export type SuperbetMarket = {
  id?: number
  name?: string
  metadata?: { tags?: string }
  odds?: SuperbetOdd[]
}

export type SuperbetEvent = {
  event_id?: number
  markets?: SuperbetMarket[]
  superbets?: SuperbetMarket[]
  fixture?: { event_name?: string; utc_date?: string }
}

export type LiveOddPick = {
  odd: number
  line: number | null
  marketName: string
  outcomeName: string
  source: 'superscore'
  eventId: number | null
}

function unwrapValue(value: unknown): unknown {
  if (value && typeof value === 'object' && 'value' in value) {
    return (value as { value: unknown }).value
  }
  return value
}

export function oddLabel(odd: SuperbetOdd): string {
  return String(odd.metadata?.name ?? odd.name ?? '').trim()
}

export function parseOverUnder(
  label: string,
): { side: 'over' | 'under'; line: number } | null {
  const m = label.match(/^(Peste|Over|Mais\s*de)\s+([0-9]+(?:[.,][0-9]+)?)/i)
  if (m) {
    const line = Number(m[2].replace(',', '.'))
    return Number.isFinite(line) ? { side: 'over', line } : null
  }
  const u = label.match(/^(Sub|Under|Menos\s*de)\s+([0-9]+(?:[.,][0-9]+)?)/i)
  if (u) {
    const line = Number(u[2].replace(',', '.'))
    return Number.isFinite(line) ? { side: 'under', line } : null
  }
  return null
}

function nameOf(market: SuperbetMarket): string {
  return String(market.name ?? '').trim()
}

export function isCornersFamily(name: string): boolean {
  return /cornere?s?|escanteio|canto(?!s?\s*a\s*canto)/i.test(name)
}

export function isGoalsTotalFamily(name: string): boolean {
  if (isCornersFamily(name)) return false
  return /total\s+gol/i.test(name) || /total\s+goals?/i.test(name)
}

export function isNextGoalFamily(name: string): boolean {
  return /^(golul|golo|goal)\s+\d+$/i.test(name.trim()) ||
    /urm[aă]torul\s+gol|next\s+goal/i.test(name)
}

export function marketHalf(name: string): CornerHalf | 'any' {
  const n = name.toLowerCase()
  if (
    /prima\s+repriz|1\.ª\s+parte|1ª\s+parte|1st\s+half|half[-\s]?time|\bht\b|\b1t\b/.test(
      n,
    )
  ) {
    return 'ht'
  }
  if (/a\s+doua\s+repriz|2\.ª\s+parte|2ª\s+parte|2nd\s+half|\bft\b|\b2t\b/.test(n)) {
    return 'ft'
  }
  return 'any'
}

/**
 * Period of a SuperScore (Superbet) market name: `Prima repriză - …` = 1st
 * half, `A doua repriză - …` = 2nd half only, no prefix = full match.
 * (`marketHalf` above is the old loose classifier; it maps 2nd-half-only
 * markets to 'ft' and must not be used to pick the alert's market.)
 */
export function marketPeriod(name: string): 'ht' | '2h' | 'match' {
  const n = name.toLowerCase()
  if (/a\s+doua\s+repriz|2\.?ª\s+parte|2nd\s+half|second\s+half|\b2t\b|2\.?º\s+tempo/.test(n)) return '2h'
  if (/prima\s+repriz|1\.?ª\s+parte|1st\s+half|first\s+half|half[-\s]?time|\bht\b|\b1t\b|1\.?º\s+tempo/.test(n)) return 'ht'
  return 'match'
}

function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
}

/** Market name without its period prefix, lower-case, no diacritics. */
export function marketBaseName(name: string): string {
  const n = stripDiacritics(name).toLowerCase().trim()
  const dash = n.split(/\s+[-–—:]\s+/)
  const body = dash.length > 1 && marketPeriod(dash[0]) !== 'match' ? dash.slice(1).join(' - ') : n
  return body
    .replace(/^(prima|a doua)\s+repriza\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const CORNER_WORDS = '(?:cornere|cornerele|corners?|cantos|escanteios)'
const GOAL_WORDS = '(?:goluri|golurile|goals?|gols|golos)'

/**
 * The match total of the market (both teams) — `Total cornere`, `Total
 * goluri` (+ `asiatice` for the Asian total). Team totals (`Total cornere CA
 * Penarol`), handicaps, intervals, 1X2… are rejected: they are not "one more
 * event in the match".
 */
export function isMatchTotalMarket(name: string, family: Market, kind: 'limit' | 'asian'): boolean {
  const base = marketBaseName(name)
  const words = family === 'corners' ? CORNER_WORDS : GOAL_WORDS
  const re =
    kind === 'asian'
      ? new RegExp(`^(?:total\\s+(?:de\\s+)?${words}\\s+asiatic[ea]?s?|asian\\s+total\\s+${words}|total\\s+${words}\\s+asian)$`)
      : new RegExp(`^(?:total\\s+(?:de\\s+)?${words}|${words}\\s+total|total\\s+${words}\\s+over/under|over/under\\s+${words})$`)
  return re.test(base)
}

/** HT alerts need a 1st-half market, FT alerts a full-match market. */
export function marketPeriodMatches(name: string, half: CornerHalf): boolean {
  const p = marketPeriod(name)
  return half === 'ht' ? p === 'ht' : p === 'match'
}

function usableOdd(odd: SuperbetOdd): number | null {
  if (odd.display === false) return null
  if (odd.status !== undefined && odd.status !== 1) return null
  const price = Number(odd.price)
  return Number.isFinite(price) && price > 1 ? price : null
}

function collectMarkets(event: SuperbetEvent | null | undefined): SuperbetMarket[] {
  if (!event) return []
  return [...(event.markets ?? []), ...(event.superbets ?? [])]
}

function wantedLine(currentTotal: number): number {
  return Math.max(0, currentTotal) + 0.5
}

/** Only the exact next line (current total + 0.5), never an alt/beaten line. */
function pickOverFromMarket(
  market: SuperbetMarket,
  currentTotal: number,
): { odd: number; line: number; outcomeName: string } | null {
  const want = wantedLine(currentTotal)
  for (const odd of market.odds ?? []) {
    const price = usableOdd(odd)
    if (price === null) continue
    const parsed = parseOverUnder(oddLabel(odd))
    if (!parsed || parsed.side !== 'over') continue
    if (Math.abs(parsed.line - want) < 1e-6) return { odd: price, line: parsed.line, outcomeName: oddLabel(odd) }
  }
  return null
}

/** 1 = the match total of the alert's market for the alert's period, else -1. */
function scoreMarket(
  market: SuperbetMarket,
  family: Market,
  half: CornerHalf,
): number {
  const name = nameOf(market)
  if (!name) return -1
  if (!isMatchTotalMarket(name, family, 'limit')) return -1
  return marketPeriodMatches(name, half) ? 1 : -1
}

export function pickMaisUmOdd(
  event: SuperbetEvent | null | undefined,
  family: Market,
  half: CornerHalf,
  currentTotal: number,
): LiveOddPick | null {
  const markets = collectMarkets(event)
  const ranked = markets
    .map((market) => ({ market, score: scoreMarket(market, family, half) }))
    .filter((row) => row.score >= 0)
    .sort((a, b) => b.score - a.score)
  for (const row of ranked) {
    const picked = pickOverFromMarket(row.market, currentTotal)
    if (!picked) continue
    return {
      odd: picked.odd,
      line: picked.line,
      marketName: nameOf(row.market),
      outcomeName: picked.outcomeName,
      source: 'superscore',
      eventId: event?.event_id ?? null,
    }
  }
  return null
}

export function isAsianMarket(name: string, family: Market): boolean {
  const n = name.toLowerCase()
  const asianHint = /asiatic|asian|asiático/.test(n)
  const handicapHint = /handicap/.test(n)
  if (!asianHint && !handicapHint) return false
  if (family === 'corners') {
    return isCornersFamily(name) || /cornere/.test(n)
  }
  if (isCornersFamily(name)) return false
  return asianHint || handicapHint
}

export function parseAsianOutcome(
  label: string,
): { side: OddsPrice['side']; line: number | null } {
  const ou = parseOverUnder(label)
  if (ou) return { side: ou.side, line: ou.line }
  const wrapped = label.match(
    /^(1|2|Home|Away|Gazde|Oaspeți|Oaspeti|Casa)\s*\(\s*([+-]?[0-9]+(?:[.,][0-9]+)?)\s*\)/i,
  )
  if (wrapped) {
    const side: OddsPrice['side'] = /^(2|away|oaspe)/i.test(wrapped[1])
      ? 'away'
      : 'home'
    const line = Number(wrapped[2].replace(',', '.'))
    return { side, line: Number.isFinite(line) ? line : null }
  }
  const bare = label.match(/^([+-][0-9]+(?:[.,][0-9]+)?)$/)
  if (bare) {
    const line = Number(bare[1].replace(',', '.'))
    return { side: 'other', line: Number.isFinite(line) ? line : null }
  }
  return { side: 'other', line: null }
}

/** Asian TOTAL (over/under) of the market for the alert's period; no handicaps. */
function scoreAsianMarket(
  market: SuperbetMarket,
  family: Market,
  half: CornerHalf,
): number {
  const name = nameOf(market)
  if (!name || !isMatchTotalMarket(name, family, 'asian')) return -1
  return marketPeriodMatches(name, half) ? 1 : -1
}

function snapshotPrices(
  market: SuperbetMarket,
  kind: OddsSnapshot['kind'],
  filter?: (price: OddsPrice) => boolean,
): OddsSnapshot | null {
  const prices: OddsPrice[] = []
  for (const odd of market.odds ?? []) {
    const price = usableOdd(odd)
    if (price === null) continue
    const label = oddLabel(odd)
    const parsed =
      kind === 'limit'
        ? (() => {
            const ou = parseOverUnder(label)
            return ou
              ? { side: ou.side as OddsPrice['side'], line: ou.line }
              : { side: 'other' as const, line: null }
          })()
        : parseAsianOutcome(label)
    const row: OddsPrice = {
      name: label || String(price),
      price,
      line: parsed.line,
      side: parsed.side,
    }
    if (filter && !filter(row)) continue
    prices.push(row)
  }
  if (!prices.length) return null
  const line =
    prices.find((p) => p.line !== null)?.line ??
    prices[0]?.line ??
    null
  return { kind, marketName: nameOf(market), line, prices }
}

export function pickLimitSnapshot(
  event: SuperbetEvent | null | undefined,
  family: Market,
  half: CornerHalf,
  currentTotal: number,
): OddsSnapshot | null {
  const want = wantedLine(currentTotal)
  const markets = collectMarkets(event)
    .map((market) => ({ market, score: scoreMarket(market, family, half) }))
    .filter((row) => row.score >= 0)
  for (const row of markets) {
    const snap = snapshotPrices(row.market, 'limit', (price) => {
      if (price.side !== 'over' && price.side !== 'under') return false
      return price.line !== null && Math.abs(price.line - want) < 1e-6
    })
    if (snap && snap.prices.some((p) => p.side === 'over')) {
      const over = snap.prices.filter((p) => p.side === 'over')
      return { ...snap, line: want, prices: [...over, ...snap.prices.filter((p) => p.side !== 'over')] }
    }
  }
  return null
}

/**
 * Asian total for the alert's period: the over/under pair of the lowest line
 * above the current total and at most one event away (e.g. total 3 → 3.25 /
 * 3.5 / 3.75 / 4). Without `currentTotal` (legacy callers) nothing is picked.
 */
export function pickAsianSnapshot(
  event: SuperbetEvent | null | undefined,
  family: Market,
  half: CornerHalf,
  currentTotal?: number,
): OddsSnapshot | null {
  if (currentTotal == null || !Number.isFinite(currentTotal)) return null
  const markets = collectMarkets(event)
    .map((market) => ({ market, score: scoreAsianMarket(market, family, half) }))
    .filter((row) => row.score >= 0)
  for (const row of markets) {
    const snap = snapshotPrices(row.market, 'asian', (price) =>
      (price.side === 'over' || price.side === 'under') &&
      price.line !== null &&
      price.line > currentTotal &&
      price.line <= currentTotal + 1 + 1e-6,
    )
    if (!snap) continue
    const overLines = snap.prices.filter((p) => p.side === 'over').map((p) => p.line as number)
    if (!overLines.length) continue
    const line = Math.min(...overLines)
    const pair = snap.prices.filter((p) => p.line !== null && Math.abs(p.line - line) < 1e-6)
    pair.sort((a, b) => (a.side === 'over' ? -1 : 1) - (b.side === 'over' ? -1 : 1))
    return { ...snap, line, prices: pair }
  }
  return null
}

export function parseOddsApiModel(raw: unknown): {
  matchId: string | null
  eventId: number | null
  names: string[]
} {
  const obj = (raw ?? {}) as Record<string, unknown>
  const matchId = unwrapValue(obj.match_id)
  const eventId = unwrapValue(obj.event_id)
  const odds = Array.isArray(obj.odds) ? obj.odds : []
  const names = odds.map((item) => {
    const row = item as Record<string, unknown>
    return String(unwrapValue(row.name) ?? '')
  })
  return {
    matchId: typeof matchId === 'string' ? matchId : null,
    eventId: typeof eventId === 'number' ? eventId : Number(eventId) || null,
    names,
  }
}
