import type { CornerHalf, Market } from './types'

export type RobobetConta = 'A' | 'B'

export type RobobetQuote = {
  id: string
  ts: string
  raw: string
  conta?: RobobetConta
  league: string | null
  home: string | null
  away: string | null
  minute: number | null
  scoreHome: number | null
  scoreAway: number | null
  marketRaw: string | null
  market: Market | null
  odd: number | null
  linha: number | null
  half: CornerHalf | null
}

export type RobobetIngestBody = {
  text?: unknown
  texto_alerta?: unknown
  conta?: unknown
  odd?: unknown
  linha?: unknown
  line?: unknown
  mercado?: unknown
  market?: unknown
  liga?: unknown
  league?: unknown
  jogo?: unknown
  match?: unknown
  tempo?: unknown
  minute?: unknown
  placar?: unknown
}

const ODD_AO_VIVO_RE = /Odd\s*Ao\s*Vivo:\s*([0-9]+[.,][0-9]+)/i
const LIGA_RE = /Liga:\s*(.+)/i
const JOGO_RE = /Jogo:\s*(.+)/i
const TEMPO_RE = /Tempo:\s*([^\n]+)/i
const MINUTE_RE = /(\d{1,3})/
const PLACAR_RE = /Placar:\s*(\d+)\s*[-–:]\s*(\d+)/i
const MERCADO_RE = /Mercado:\s*(.+)/i
const TEAMS_RE = /\s+(?:vs\.?|v\.?|x|[-–]|·)\s+/i
export function parseLinha(mercado: string | null): number | null {
  if (!mercado) return null
  const linha = mercado.match(/(?:linha|line)\s*([0-9]+(?:[.,][0-9]+)?)/i)
  if (linha?.[1]) {
    const n = Number(linha[1].replace(',', '.'))
    if (Number.isFinite(n)) return n
  }
  const over = mercado.match(/(?:Mais\s*de|Over)\s*([0-9]+(?:[.,][0-9]+)?)/i)
  if (over?.[1]) {
    const n = Number(over[1].replace(',', '.'))
    if (Number.isFinite(n)) return n
  }
  const race = mercado.match(/Race\s*(?:to\s*)?([0-9]+(?:[.,][0-9]+)?)/i)
  if (race?.[1]) {
    const n = Number(race[1].replace(',', '.'))
    if (Number.isFinite(n)) return n
  }
  return null
}

export function parseDecimal(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(',', '.')
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : null
}

export function parseOddPrice(value: unknown): number | null {
  const n = parseDecimal(value)
  return n !== null && n > 1 ? n : null
}

export function parseConta(value: unknown): RobobetConta | undefined {
  const raw = String(value ?? '')
    .trim()
    .toUpperCase()
  if (raw === 'A' || raw === 'B') return raw
  return undefined
}

function firstLine(re: RegExp, text: string): string | null {
  const m = text.match(re)
  if (!m?.[1]) return null
  return m[1].replace(/\s+/g, ' ').trim() || null
}

function parseTeams(jogo: string | null): { home: string | null; away: string | null } {
  if (!jogo) return { home: null, away: null }
  const parts = jogo.split(TEAMS_RE).map((p) => p.trim()).filter(Boolean)
  if (parts.length >= 2) return { home: parts[0], away: parts[1] }
  return { home: jogo, away: null }
}

export function normalizeMarketFamily(
  mercado: string | null,
  conta?: RobobetConta,
): Market | null {
  const raw = (mercado ?? '').toLowerCase()
  if (/escanteio|canto|corner|cornere/.test(raw)) return 'corners'
  if (/\bgols?\b|\bgolo|\bgoals?\b/.test(raw)) return 'goals'
  if (conta === 'A') return 'corners'
  if (conta === 'B') return 'goals'
  return null
}

export function parseHalfHint(
  mercado: string | null,
  minute: number | null,
  tempoLine: string | null,
): CornerHalf | null {
  const blob = `${mercado ?? ''} ${tempoLine ?? ''}`.toLowerCase()
  if (/\(1t\)|\b1t\b|1\.ª|1ª|prima repriz|half.?time|ht\b/.test(blob) && !/\bjt\b/.test(blob)) {
    return 'ht'
  }
  if (/\(2t\)|\b2t\b|2\.ª|2ª|a doua repriz/.test(blob)) return 'ft'
  if (/\(jt\)|\bjt\b|jogo todo|full.?time/.test(blob)) {
    if (minute !== null) return minute <= 45 ? 'ht' : 'ft'
    return 'ft'
  }
  if (minute === null) return null
  return minute <= 45 ? 'ht' : 'ft'
}

export function parseRobobetText(text: string, conta?: RobobetConta): RobobetQuote {
  const liga = firstLine(LIGA_RE, text)
  const jogo = firstLine(JOGO_RE, text)
  const { home, away } = parseTeams(jogo)
  const tempoLine = firstLine(TEMPO_RE, text)
  const minuteMatch = tempoLine?.match(MINUTE_RE)
  const minute = minuteMatch ? Number(minuteMatch[1]) : null
  const placar = text.match(PLACAR_RE)
  const mercado = firstLine(MERCADO_RE, text)
  const oddMatch = text.match(ODD_AO_VIVO_RE)
  const odd = oddMatch ? parseOddPrice(oddMatch[1]) : null
  const market = normalizeMarketFamily(mercado, conta)
  return {
    id: `rb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    raw: text,
    conta,
    league: liga,
    home,
    away,
    minute: Number.isFinite(minute) ? minute : null,
    scoreHome: placar ? Number(placar[1]) : null,
    scoreAway: placar ? Number(placar[2]) : null,
    marketRaw: mercado,
    market,
    odd,
    linha: parseLinha(mercado),
    half: parseHalfHint(mercado, minute, tempoLine),
  }
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

export function quoteFromIngestBody(body: RobobetIngestBody): RobobetQuote {
  const text = asString(body.texto_alerta) ?? asString(body.text) ?? ''
  const conta = parseConta(body.conta)
  const parsed = parseRobobetText(text, conta)
  const liga = asString(body.liga) ?? asString(body.league)
  const jogo = asString(body.jogo) ?? asString(body.match)
  const mercado = asString(body.mercado) ?? asString(body.market)
  const teams = jogo ? parseTeams(jogo) : { home: parsed.home, away: parsed.away }
  const linha =
    parseDecimal(body.linha) ?? parseDecimal(body.line) ?? parsed.linha
  const odd = parseOddPrice(body.odd) ?? parsed.odd
  const market = normalizeMarketFamily(mercado ?? parsed.marketRaw, conta) ?? parsed.market
  const minuteRaw = asString(body.tempo) ?? asString(body.minute)
  const minute =
    minuteRaw && MINUTE_RE.test(minuteRaw)
      ? Number(minuteRaw.match(MINUTE_RE)?.[1])
      : parsed.minute
  return {
    ...parsed,
    conta: conta ?? parsed.conta,
    league: liga ?? parsed.league,
    home: teams.home,
    away: teams.away,
    marketRaw: mercado ?? parsed.marketRaw,
    market,
    odd: odd && odd > 1 ? odd : null,
    linha: linha && linha > 0 ? linha : parsed.linha,
    minute: Number.isFinite(minute) ? minute : parsed.minute,
    half: parseHalfHint(mercado ?? parsed.marketRaw, minute ?? parsed.minute, minuteRaw),
    raw: text || parsed.raw,
  }
}

export const ROBOBET_MATCH_WINDOW_MS = 8 * 60 * 1000
export const ROBOBET_STORE_CAP = 500
