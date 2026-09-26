import type { CornerHalf, Market, MatchTally, RuleId } from './types'
import { cornerHalfOf } from './windows'

export type TipSource = 'superscore' | 'sokkerpro' | 'robobet'
export type TipStatus = 'open' | 'won' | 'lost'
export type EntryType = 'goals_ht' | 'goals_ft' | 'corners_ht' | 'corners_ft'

export type Tip = {
  id: string
  ts: string
  league: string
  home: string
  away: string
  market: Market
  half: CornerHalf
  minute: number
  period: number
  odd: number
  line: number | null
  stake: 1
  status: TipStatus
  pnl: number | null
  rule: RuleId
  scores: { home: number; away: number }
  fixtureId: string
  matchLabel: string
  alertId: string
  source: TipSource
  sourceLabel: string
  goalsTally?: MatchTally
  cornersTally?: MatchTally
  settledAt: string | null
  longDeadline: number | null
}

export type RoiRow = {
  key: EntryType
  label: string
  tips: number
  open: number
  won: number
  lost: number
  staked: number
  pnl: number
  roi: number | null
}

export type LeagueRow = {
  league: string
  tips: number
  open: number
  won: number
  lost: number
  pnl: number
  roi: number | null
}

export const ENTRY_LABELS: Record<EntryType, string> = {
  goals_ht: 'Golos HT',
  goals_ft: 'Golos FT',
  corners_ht: 'Cantos HT',
  corners_ft: 'Cantos FT',
}

export const ENTRY_ORDER: EntryType[] = [
  'goals_ht',
  'goals_ft',
  'corners_ht',
  'corners_ft',
]

export function entryTypeOf(market: Market, half: CornerHalf): EntryType {
  return market === 'corners'
    ? half === 'ft'
      ? 'corners_ft'
      : 'corners_ht'
    : half === 'ft'
      ? 'goals_ft'
      : 'goals_ht'
}

export function halfOfAlert(
  market: Market,
  minute: number,
  period: number,
  cornerHalf?: CornerHalf | null,
): CornerHalf {
  if (market === 'corners') {
    return cornerHalf ?? cornerHalfOf(minute, period) ?? (period >= 2 ? 'ft' : 'ht')
  }
  return period >= 2 || minute > 45 ? 'ft' : 'ht'
}

export function formatOddPt(odd: number): string {
  return odd.toFixed(2).replace('.', ',')
}

export function tipPnl(odd: number, status: TipStatus): number | null {
  if (status === 'won') return odd - 1
  if (status === 'lost') return -1
  return null
}

function emptyRow(key: EntryType): RoiRow {
  return {
    key,
    label: ENTRY_LABELS[key],
    tips: 0,
    open: 0,
    won: 0,
    lost: 0,
    staked: 0,
    pnl: 0,
    roi: null,
  }
}

export function computeRoi(tips: Tip[]): RoiRow[] {
  const byKey = new Map<EntryType, RoiRow>(
    ENTRY_ORDER.map((key) => [key, emptyRow(key)]),
  )
  for (const tip of tips) {
    const key = entryTypeOf(tip.market, tip.half)
    const row = byKey.get(key) ?? emptyRow(key)
    row.tips += 1
    row.staked += tip.stake
    if (tip.status === 'open') row.open += 1
    if (tip.status === 'won') {
      row.won += 1
      row.pnl += tip.pnl ?? tip.odd - 1
    }
    if (tip.status === 'lost') {
      row.lost += 1
      row.pnl += tip.pnl ?? -1
    }
    byKey.set(key, row)
  }
  return ENTRY_ORDER.map((key) => {
    const row = byKey.get(key) ?? emptyRow(key)
    const settled = row.won + row.lost
    row.roi = settled ? row.pnl / settled : null
    return row
  })
}

export function computeLeagueFollowup(tips: Tip[]): LeagueRow[] {
  const by = new Map<string, LeagueRow>()
  for (const tip of tips) {
    const league = tip.league.trim() || 'Sem liga'
    const row = by.get(league) ?? {
      league,
      tips: 0,
      open: 0,
      won: 0,
      lost: 0,
      pnl: 0,
      roi: null,
    }
    row.tips += 1
    if (tip.status === 'open') row.open += 1
    if (tip.status === 'won') {
      row.won += 1
      row.pnl += tip.pnl ?? tip.odd - 1
    }
    if (tip.status === 'lost') {
      row.lost += 1
      row.pnl += tip.pnl ?? -1
    }
    by.set(league, row)
  }
  return [...by.values()]
    .map((row) => {
      const settled = row.won + row.lost
      return { ...row, roi: settled ? row.pnl / settled : null }
    })
    .sort((a, b) => b.tips - a.tips || a.league.localeCompare(b.league, 'pt'))
}

export function stripAccents(value: string): string {
  return value.normalize('NFD').replace(/\p{M}/gu, '')
}

export function normalizeTeamName(value: string): string {
  return stripAccents(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(
      /\b(fc|cf|sc|ac|fk|sk|nk|cd|afc|united|city|club|de|da|do|the|if|bk|fk)\b/g,
      ' ',
    )
    .replace(/\s+/g, ' ')
    .trim()
}

function tokenJaccard(a: string, b: string): number {
  const ta = new Set(a.split(' ').filter((t) => t.length > 1))
  const tb = new Set(b.split(' ').filter((t) => t.length > 1))
  if (!ta.size || !tb.size) return a && b && (a.includes(b) || b.includes(a)) ? 0.7 : 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter += 1
  return inter / (ta.size + tb.size - inter)
}

export function teamNameScore(a: string, b: string): number {
  const na = normalizeTeamName(a)
  const nb = normalizeTeamName(b)
  if (!na || !nb) return 0
  if (na === nb) return 1
  if (na.includes(nb) || nb.includes(na)) return 0.86
  return tokenJaccard(na, nb)
}

export function fixtureMatchesQuote(
  home: string,
  away: string,
  qHome: string | null,
  qAway: string | null,
): number {
  if (!qHome || !qAway) return 0
  const direct = teamNameScore(home, qHome) + teamNameScore(away, qAway)
  const swapped = teamNameScore(home, qAway) + teamNameScore(away, qHome)
  return Math.max(direct, swapped) / 2
}

export const TEAM_MATCH_MIN = 0.58
