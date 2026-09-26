import { fixtureMatchesQuote, TEAM_MATCH_MIN } from './tips'
import type { CornerHalf, Market } from './types'

/**
 * SokkerPro public O/U is a **reference** market, not next-goal / next-corner.
 *
 * Mais-um line rule:
 * - Wanted Over = current total + 0.5 (golos e cantos).
 * - Prefer `*_LIVE` over the matching preodds key.
 * - Golos keys: `BET365_GOLS_OVER_2_5` (2.5 → `2_5`). HT tries `_HT` / `_1T` first, then FT.
 * - Cantos keys: singular `CANTO` (e.g. `BET365_CANTO_OVER_9`). If 8.5 is missing, pick the
 *   nearest available Over **strictly above** current total (typically ceil of wanted).
 */
export const SOKKERPRO_SOURCE = 'sokkerpro' as const
export const SOKKERPRO_SOURCE_LABEL = 'SokkerPro O/U'
export const SOKKERPRO_BOOK = 'BET365'
/** Default TTL for a successful mini board (~1 MB). Longer than the 45s poller tick. */
export const SOKKERPRO_BOARD_CACHE_MS = 90_000
/** Preodds per fixture. */
export const SOKKERPRO_CACHE_MS = 45_000
export const SOKKERPRO_PREODDS_CACHE_MS = SOKKERPRO_CACHE_MS

export type SokkerProFamily = Market
export type SokkerProSide = 'over' | 'under'

export type SokkerProParsedKey = {
  book: string
  family: SokkerProFamily
  side: SokkerProSide
  line: number
  period: CornerHalf
  live: boolean
  rawKey: string
}

export type SokkerProPick = {
  odd: number
  line: number
  side: SokkerProSide
  rawKey: string
  live: boolean
  book: string
  period: CornerHalf
  fixtureId: string | null
  underOdd: number | null
  underKey: string | null
}

export type SokkerProFixture = {
  fixtureId: string
  localTeamName: string
  visitorTeamName: string
  status: string
  minute: number | null
  odds: Record<string, string>
}

const KEY_RE =
  /^([A-Z0-9]+)_((?:GOLS)|(?:CANTOS?))(?:_(HT|1T|1ST|FT|2T))?_(OVER|UNDER)_(\d+(?:[._]\d+)?)(_LIVE)?$/i

export function wantedMaisUmLine(currentTotal: number): number {
  return Math.max(0, currentTotal) + 0.5
}

export function parseSokkerProPrice(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) && raw > 1 ? raw : null
  }
  if (typeof raw !== 'string') return null
  const head = raw.split('#')[0]?.trim().replace(',', '.') ?? ''
  const n = Number(head)
  return Number.isFinite(n) && n > 1 ? n : null
}

export function encodeSokkerProLine(line: number): string {
  const scaled = Math.round(line * 100) / 100
  if (Number.isInteger(scaled)) return String(scaled)
  const [whole, frac] = scaled.toFixed(2).replace(/0+$/, '').split('.')
  return `${whole}_${frac}`
}

export function decodeSokkerProLine(raw: string): number | null {
  const n = Number(raw.replace('_', '.').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

export function buildSokkerProOddsKey(args: {
  book?: string
  family: SokkerProFamily
  side: SokkerProSide
  line: number
  period?: CornerHalf
  live?: boolean
}): string {
  const book = (args.book ?? SOKKERPRO_BOOK).toUpperCase()
  const family = args.family === 'corners' ? 'CANTO' : 'GOLS'
  const period = args.period === 'ht' ? '_HT' : ''
  const side = args.side.toUpperCase()
  const live = args.live ? '_LIVE' : ''
  return `${book}_${family}${period}_${side}_${encodeSokkerProLine(args.line)}${live}`
}

export function parseSokkerProOddsKey(rawKey: string): SokkerProParsedKey | null {
  const m = KEY_RE.exec(rawKey.trim())
  if (!m) return null
  const familyRaw = m[2].toUpperCase()
  const periodRaw = (m[3] ?? '').toUpperCase()
  const line = decodeSokkerProLine(m[5])
  if (line === null) return null
  // 2nd-half-only keys are neither the HT nor the full-match line.
  if (periodRaw === '2T') return null
  const period: CornerHalf =
    periodRaw === 'HT' || periodRaw === '1T' || periodRaw === '1ST' ? 'ht' : 'ft'
  return {
    book: m[1].toUpperCase(),
    family: familyRaw.startsWith('CANTO') ? 'corners' : 'goals',
    side: m[4].toUpperCase() === 'UNDER' ? 'under' : 'over',
    line,
    period,
    live: Boolean(m[6]),
    rawKey,
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function ingestOddsEntry(into: Record<string, string>, key: string, value: unknown): void {
  if (!parseSokkerProOddsKey(key)) return
  if (typeof value === 'string' || typeof value === 'number') {
    into[key] = String(value)
    return
  }
  if (value && typeof value === 'object' && 'price' in (value as object)) {
    into[key] = String((value as { price: unknown }).price)
  }
}

function mergePreoddsSnapshots(rows: unknown[], into: Record<string, string>): void {
  const snaps = rows
    .map(asRecord)
    .filter((row): row is Record<string, unknown> => Boolean(row))
    .sort((a, b) => {
      const ta = Date.parse(str(a.created_at)) || 0
      const tb = Date.parse(str(b.created_at)) || 0
      return ta - tb
    })
  for (const snap of snaps) {
    for (const [key, value] of Object.entries(snap)) {
      ingestOddsEntry(into, key, value)
    }
  }
}

export function collectOddsMap(raw: unknown, into: Record<string, string> = {}, depth = 0): Record<string, string> {
  if (!raw || depth > 8) return into
  if (Array.isArray(raw)) {
    const looksLikePreodds = raw.some((item) => {
      const rec = asRecord(item)
      return Boolean(rec && (rec.created_at || Object.keys(rec).some((k) => parseSokkerProOddsKey(k))))
    })
    if (looksLikePreodds) {
      mergePreoddsSnapshots(raw, into)
      return into
    }
    for (const item of raw) collectOddsMap(item, into, depth + 1)
    return into
  }
  const obj = asRecord(raw)
  if (!obj) return into
  if (Array.isArray(obj.preodds)) {
    mergePreoddsSnapshots(obj.preodds, into)
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'preodds') continue
      collectOddsMap(value, into, depth + 1)
    }
    return into
  }
  for (const [key, value] of Object.entries(obj)) {
    ingestOddsEntry(into, key, value)
    if (parseSokkerProOddsKey(key)) continue
    if (value && typeof value === 'object') collectOddsMap(value, into, depth + 1)
  }
  return into
}

function readFixtureId(row: Record<string, unknown>): string | null {
  const raw = row.fixtureId ?? row.fixture_id ?? row.id
  const id = str(raw).trim()
  return id || null
}

export function normalizeSokkerProFixture(raw: unknown): SokkerProFixture | null {
  const row = asRecord(raw)
  if (!row) return null
  const fixtureId = readFixtureId(row)
  const localTeamName = str(row.localTeamName ?? row.homeTeamName ?? row.home ?? row.local)
  const visitorTeamName = str(
    row.visitorTeamName ?? row.awayTeamName ?? row.away ?? row.visitor,
  )
  if (!fixtureId || !localTeamName || !visitorTeamName) return null
  return {
    fixtureId,
    localTeamName,
    visitorTeamName,
    status: str(row.status ?? row.state),
    minute: (() => {
      const n = Number(row.minute ?? row.min)
      return Number.isFinite(n) ? n : null
    })(),
    odds: collectOddsMap(row),
  }
}

export function flattenMiniFixtures(raw: unknown): SokkerProFixture[] {
  const root = asRecord(raw) ?? {}
  const data = asRecord(root.data) ?? root
  const categorized = data.sortedCategorizedFixtures
  const buckets = Array.isArray(categorized)
    ? categorized
    : Array.isArray(data.fixtures)
      ? [{ fixtures: data.fixtures }]
      : []
  const out: SokkerProFixture[] = []
  const seen = new Set<string>()
  for (const bucket of buckets) {
    const rec = asRecord(bucket)
    const list = rec && Array.isArray(rec.fixtures) ? rec.fixtures : []
    for (const item of list) {
      const fixture = normalizeSokkerProFixture(item)
      if (!fixture || seen.has(fixture.fixtureId)) continue
      seen.add(fixture.fixtureId)
      out.push(fixture)
    }
  }
  return out
}

function statusLiveScore(status: string): number {
  const s = status.trim().toLowerCase()
  if (s === '1st' || s === '2nd' || s === 'ht' || s === 'live' || s === 'inplay') return 2
  if (s === 'ns' || s === 'ft' || s === 'finished') return 0
  return 1
}

export function matchSokkerProFixture(
  fixtures: SokkerProFixture[],
  home: string,
  away: string,
): SokkerProFixture | null {
  let best: { fixture: SokkerProFixture; score: number; live: number } | null = null
  for (const fixture of fixtures) {
    const score = fixtureMatchesQuote(
      home,
      away,
      fixture.localTeamName,
      fixture.visitorTeamName,
    )
    if (score < TEAM_MATCH_MIN) continue
    const live = statusLiveScore(fixture.status)
    if (
      !best ||
      score > best.score ||
      (score === best.score && live > best.live)
    ) {
      best = { fixture, score, live }
    }
  }
  return best?.fixture ?? null
}

type RankedQuote = SokkerProParsedKey & { odd: number }

function periodScore(parsed: SokkerProParsedKey, half: CornerHalf): number {
  if (half === 'ht') return parsed.period === 'ht' ? 3 : 1
  return parsed.period === 'ft' ? 3 : 0
}

function quotesFromMap(odds: Record<string, string>): RankedQuote[] {
  const out: RankedQuote[] = []
  for (const [key, raw] of Object.entries(odds)) {
    const parsed = parseSokkerProOddsKey(key)
    const odd = parseSokkerProPrice(raw)
    if (!parsed || odd === null) continue
    out.push({ ...parsed, odd })
  }
  return out
}

function lookupExact(
  odds: Record<string, string>,
  args: {
    family: SokkerProFamily
    side: SokkerProSide
    line: number
    half: CornerHalf
  },
): RankedQuote | null {
  // HT alerts only take 1st-half keys, FT alerts only full-match keys.
  const periods: Array<CornerHalf | undefined> =
    args.half === 'ht' ? ['ht'] : [undefined]
  // Live keys only: a pre-match price for "current total + 0.5" is stale.
  const lives = [true]
  for (const period of periods) {
    for (const live of lives) {
      const key = buildSokkerProOddsKey({
        family: args.family,
        side: args.side,
        line: args.line,
        period,
        live,
      })
      const odd = parseSokkerProPrice(odds[key])
      const parsed = parseSokkerProOddsKey(key)
      if (odd && parsed) return { ...parsed, odd, rawKey: key }
    }
  }
  return null
}

function rankQuote(quote: RankedQuote, half: CornerHalf, wanted: number): number[] {
  const exact = Math.abs(quote.line - wanted) < 1e-6 ? 1 : 0
  const dist = Math.abs(quote.line - wanted)
  const book = quote.book === SOKKERPRO_BOOK ? 1 : 0
  return [
    periodScore(quote, half),
    exact,
    quote.live ? 1 : 0,
    book,
    -dist,
    -quote.line,
  ]
}

function betterRank(a: number[], b: number[]): boolean {
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return a[i] > b[i]
  }
  return false
}

function pickSide(args: {
  odds: Record<string, string>
  family: SokkerProFamily
  side: SokkerProSide
  half: CornerHalf
  currentTotal: number
  wanted: number
}): RankedQuote | null {
  // Only the exact next line (current total + 0.5) of the alert's period.
  const lines = [args.wanted]
  for (const line of lines) {
    if (line <= args.currentTotal) continue
    const exact = lookupExact(args.odds, {
      family: args.family,
      side: args.side,
      line,
      half: args.half,
    })
    if (exact) return exact
  }

  let best: { quote: RankedQuote; rank: number[] } | null = null
  for (const quote of quotesFromMap(args.odds)) {
    if (quote.family !== args.family || quote.side !== args.side) continue
    if (quote.line <= args.currentTotal) continue
    if (quote.period !== args.half) continue
    if (!quote.live) continue
    if (Math.abs(quote.line - args.wanted) > 1e-6) continue
    const rank = rankQuote(quote, args.half, args.wanted)
    if (!best || betterRank(rank, best.rank)) best = { quote, rank }
  }
  return best?.quote ?? null
}

export function pickSokkerProMaisUm(
  odds: Record<string, string>,
  family: SokkerProFamily,
  half: CornerHalf,
  currentTotal: number,
  fixtureId: string | null = null,
): SokkerProPick | null {
  const wanted = wantedMaisUmLine(currentTotal)
  const over = pickSide({
    odds,
    family,
    side: 'over',
    half,
    currentTotal,
    wanted,
  })
  if (!over) return null
  const under =
    lookupExact(odds, {
      family,
      side: 'under',
      line: over.line,
      half,
    }) ??
    quotesFromMap(odds).find(
      (q) =>
        q.family === family &&
        q.side === 'under' &&
        Math.abs(q.line - over.line) < 1e-6 &&
        q.period === half &&
        q.live,
    ) ??
    null
  return {
    odd: over.odd,
    line: over.line,
    side: 'over',
    rawKey: over.rawKey,
    live: over.live,
    book: over.book,
    period: over.period,
    fixtureId,
    underOdd: under?.odd ?? null,
    underKey: under?.rawKey ?? null,
  }
}

export function snapshotFromSokkerProPick(pick: SokkerProPick): {
  kind: 'limit'
  marketName: string
  line: number
  prices: {
    name: string
    price: number
    line: number
    side: SokkerProSide
  }[]
} {
  const lineLabel = String(pick.line).replace('.', ',')
  const prices: {
    name: string
    price: number
    line: number
    side: SokkerProSide
  }[] = [
    {
      name: `Over ${lineLabel}`,
      price: pick.odd,
      line: pick.line,
      side: 'over',
    },
  ]
  if (pick.underOdd && pick.underOdd > 1) {
    prices.push({
      name: `Under ${lineLabel}`,
      price: pick.underOdd,
      line: pick.line,
      side: 'under',
    })
  }
  return {
    kind: 'limit',
    marketName: SOKKERPRO_SOURCE_LABEL,
    line: pick.line,
    prices,
  }
}

export function utcDateKey(date = new Date()): string {
  return date.toISOString().slice(0, 10)
}

export function utcDateKeyDaysAgo(days: number, date = new Date()): string {
  const d = new Date(date.getTime() - days * 86_400_000)
  return utcDateKey(d)
}
