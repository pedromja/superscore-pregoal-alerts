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

function pickOverFromMarket(
  market: SuperbetMarket,
  currentTotal: number,
): { odd: number; line: number; outcomeName: string } | null {
  const want = wantedLine(currentTotal)
  const overs: { odd: number; line: number; outcomeName: string }[] = []
  for (const odd of market.odds ?? []) {
    const price = usableOdd(odd)
    if (price === null) continue
    const parsed = parseOverUnder(oddLabel(odd))
    if (!parsed || parsed.side !== 'over') continue
    if (parsed.line <= currentTotal) continue
    overs.push({ odd: price, line: parsed.line, outcomeName: oddLabel(odd) })
  }
  if (!overs.length) return null
  const exact = overs.find((o) => Math.abs(o.line - want) < 1e-6)
  if (exact) return exact
  overs.sort((a, b) => a.line - b.line || a.odd - b.odd)
  return overs[0]
}

function scoreMarket(
  market: SuperbetMarket,
  family: Market,
  half: CornerHalf,
): number {
  const name = nameOf(market)
  if (!name) return -1
  if (family === 'corners') {
    if (!isCornersFamily(name)) return -1
  } else if (!isGoalsTotalFamily(name)) {
    return -1
  }
  const mh = marketHalf(name)
  if (mh === half) return 3
  if (mh === 'any' && half === 'ft') return 2
  if (mh === 'any' && half === 'ht') return 1
  return -1
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
