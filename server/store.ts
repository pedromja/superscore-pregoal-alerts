import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarket } from '../src/lib/market.ts'
import type {
  AlertSettings,
  CornerHalf,
  Fixture,
  Market,
  MomentumPayload,
} from '../src/lib/types.ts'
import { parseCornerHalf, parseCornerHalfOpt } from '../src/lib/windows.ts'
import { DATA_DIR, MATCHES_DIR } from './config.ts'
import type { GoalRecord, LoggedAlert, ParamVersion, PushSub, StoredMatch } from './types.ts'

export type LearnScope = 'goals' | 'corners_ht' | 'corners_ft'

const FILES: Record<
  LearnScope,
  {
    alerts: string
    events: string
    params: string
    history: string
    proposal: string
  }
> = {
  goals: {
    alerts: 'alerts.json',
    events: 'goals.json',
    params: 'params.json',
    history: 'params_history.json',
    proposal: 'proposal.json',
  },
  corners_ht: {
    alerts: 'alerts_corners_ht.json',
    events: 'corners_ht.json',
    params: 'params_corners_ht.json',
    history: 'params_history_corners_ht.json',
    proposal: 'proposal_corners_ht.json',
  },
  corners_ft: {
    alerts: 'alerts_corners_ft.json',
    events: 'corners_ft.json',
    params: 'params_corners_ft.json',
    history: 'params_history_corners_ft.json',
    proposal: 'proposal_corners_ft.json',
  },
}

export function learnScope(
  market: Market = 'goals',
  half?: CornerHalf | null,
): LearnScope {
  if (parseMarket(market) !== 'corners') return 'goals'
  return parseCornerHalf(half) === 'ft' ? 'corners_ft' : 'corners_ht'
}

function readJson<T>(file: string, fallback: T): T {
  const path = join(DATA_DIR, file)
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(join(DATA_DIR, file), JSON.stringify(value, null, 2))
}

export function loadActiveMarket(): Market {
  return parseMarket(readJson<{ market?: string }>('market.json', {}).market)
}

export function saveActiveMarket(market: Market): void {
  writeJson('market.json', { market: parseMarket(market) })
}

export function loadSubscriptions(): PushSub[] {
  return readJson('subscriptions.json', [])
}

export function saveSubscriptions(items: PushSub[]): void {
  writeJson('subscriptions.json', items)
}

export function loadAlerts(
  market: Market = 'goals',
  half?: CornerHalf | null,
): LoggedAlert[] {
  return readJson(FILES[learnScope(market, half)].alerts, [])
}

export function saveAlerts(
  items: LoggedAlert[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].alerts, items)
}

export function loadGoals(
  market: Market = 'goals',
  half?: CornerHalf | null,
): GoalRecord[] {
  return readJson(FILES[learnScope(market, half)].events, [])
}

export function saveGoals(
  items: GoalRecord[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].events, items)
}

export function loadSent(): string[] {
  return readJson('sent.json', [])
}

export function saveSent(items: string[]): void {
  writeJson('sent.json', items.slice(-4000))
}

export function loadPrimed(): string[] {
  return readJson('primed.json', [])
}

export function savePrimed(items: string[]): void {
  writeJson('primed.json', items)
}

export function loadParams(
  market: Market = 'goals',
  half?: CornerHalf | null,
): AlertSettings | null {
  return readJson<AlertSettings | null>(FILES[learnScope(market, half)].params, null)
}

export function saveParams(
  settings: AlertSettings,
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  const h = market === 'corners' ? parseCornerHalf(half ?? settings.cornerHalf) : undefined
  writeJson(FILES[learnScope(market, h)].params, {
    ...settings,
    market,
    cornerHalf: h,
  })
}

export function loadHistory(
  market: Market = 'goals',
  half?: CornerHalf | null,
): ParamVersion[] {
  return readJson(FILES[learnScope(market, half)].history, [])
}

export function saveHistory(
  items: ParamVersion[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].history, items)
}

export function loadProposal(
  market: Market = 'goals',
  half?: CornerHalf | null,
): ParamVersion | null {
  return readJson<ParamVersion | null>(FILES[learnScope(market, half)].proposal, null)
}

export function saveProposal(
  item: ParamVersion | null,
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  writeJson(FILES[learnScope(market, half)].proposal, item)
}

export function saveMatch(match: StoredMatch): void {
  writeFileSync(
    join(MATCHES_DIR, `${match.fixture.id}.json`),
    JSON.stringify(match),
  )
}

export function loadMatch(fixtureId: string): StoredMatch | null {
  const path = join(MATCHES_DIR, `${matchPath(fixtureId)}`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredMatch
  } catch {
    return null
  }
}

function matchPath(fixtureId: string): string {
  return `${fixtureId}.json`
}

export function listMatches(): StoredMatch[] {
  if (!existsSync(MATCHES_DIR)) return []
  return readdirSync(MATCHES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadMatch(name.replace(/\.json$/, '')))
    .filter((m): m is StoredMatch => m !== null)
}

export function upsertAlerts(
  incoming: LoggedAlert[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): LoggedAlert[] {
  const h = market === 'corners' ? parseCornerHalf(half) : undefined
  const alerts = loadAlerts(market, h)
  const byId = new Map(alerts.map((a) => [a.id, a]))
  for (const item of incoming) {
    const prev = byId.get(item.id)
    byId.set(
      item.id,
      prev
        ? {
            ...item,
            ...prev,
            ...item,
            feedback: prev.feedback ?? item.feedback,
            market,
            cornerHalf: h ?? item.cornerHalf,
          }
        : { ...item, market, cornerHalf: h ?? item.cornerHalf },
    )
  }
  const next = [...byId.values()]
  saveAlerts(next, market, h)
  return next
}

export function upsertGoals(
  incoming: GoalRecord[],
  market: Market = 'goals',
  half?: CornerHalf | null,
): void {
  const h = market === 'corners' ? parseCornerHalf(half) : undefined
  const goals = loadGoals(market, h)
  const key = (g: GoalRecord) => `${g.fixtureId}:${g.period}:${g.min}:${g.side}`
  const byId = new Map(goals.map((g) => [key(g), g]))
  for (const item of incoming) {
    byId.set(key(item), {
      ...byId.get(key(item)),
      ...item,
      market,
      cornerHalf: h ?? item.cornerHalf,
    })
  }
  saveGoals([...byId.values()], market, h)
}

export function sentKey(
  market: Market,
  fixtureId: string,
  alertId: string,
  half?: CornerHalf | null,
): string {
  if (market === 'goals') return `${fixtureId}:${alertId}`
  const h = parseCornerHalfOpt(half)
  return h ? `corners:${h}:${fixtureId}:${alertId}` : `corners:${fixtureId}:${alertId}`
}

export function primedKey(market: Market, fixtureId: string): string {
  return market === 'goals' ? fixtureId : `${market}:${fixtureId}`
}

export function markSent(key: string): boolean {
  const sent = loadSent()
  if (sent.includes(key)) return false
  sent.push(key)
  saveSent(sent)
  return true
}

export function primeFixture(id: string): boolean {
  const primed = loadPrimed()
  if (primed.includes(id)) return false
  primed.push(id)
  savePrimed(primed)
  return true
}

export function isPrimed(id: string): boolean {
  return loadPrimed().includes(id)
}

export type { Fixture, MomentumPayload }
