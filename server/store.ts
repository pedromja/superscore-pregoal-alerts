import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseMarket } from '../src/lib/market.ts'
import type { AlertSettings, Fixture, Market, MomentumPayload } from '../src/lib/types.ts'
import { DATA_DIR, MATCHES_DIR } from './config.ts'
import type { GoalRecord, LoggedAlert, ParamVersion, PushSub, StoredMatch } from './types.ts'

const FILES: Record<
  Market,
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
  corners: {
    alerts: 'alerts_corners.json',
    events: 'corners.json',
    params: 'params_corners.json',
    history: 'params_history_corners.json',
    proposal: 'proposal_corners.json',
  },
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

export function loadAlerts(market: Market = 'goals'): LoggedAlert[] {
  return readJson(FILES[market].alerts, [])
}

export function saveAlerts(items: LoggedAlert[], market: Market = 'goals'): void {
  writeJson(FILES[market].alerts, items)
}

export function loadGoals(market: Market = 'goals'): GoalRecord[] {
  return readJson(FILES[market].events, [])
}

export function saveGoals(items: GoalRecord[], market: Market = 'goals'): void {
  writeJson(FILES[market].events, items)
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

export function loadParams(market: Market = 'goals'): AlertSettings | null {
  return readJson<AlertSettings | null>(FILES[market].params, null)
}

export function saveParams(settings: AlertSettings, market: Market = 'goals'): void {
  writeJson(FILES[market].params, { ...settings, market })
}

export function loadHistory(market: Market = 'goals'): ParamVersion[] {
  return readJson(FILES[market].history, [])
}

export function saveHistory(items: ParamVersion[], market: Market = 'goals'): void {
  writeJson(FILES[market].history, items)
}

export function loadProposal(market: Market = 'goals'): ParamVersion | null {
  return readJson<ParamVersion | null>(FILES[market].proposal, null)
}

export function saveProposal(item: ParamVersion | null, market: Market = 'goals'): void {
  writeJson(FILES[market].proposal, item)
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
): LoggedAlert[] {
  const alerts = loadAlerts(market)
  const byId = new Map(alerts.map((a) => [a.id, a]))
  for (const item of incoming) {
    const prev = byId.get(item.id)
    byId.set(
      item.id,
      prev
        ? { ...item, ...prev, ...item, feedback: prev.feedback ?? item.feedback, market }
        : { ...item, market },
    )
  }
  const next = [...byId.values()]
  saveAlerts(next, market)
  return next
}

export function upsertGoals(
  incoming: GoalRecord[],
  market: Market = 'goals',
): void {
  const goals = loadGoals(market)
  const key = (g: GoalRecord) => `${g.fixtureId}:${g.period}:${g.min}:${g.side}`
  const byId = new Map(goals.map((g) => [key(g), g]))
  for (const item of incoming) {
    byId.set(key(item), { ...byId.get(key(item)), ...item, market })
  }
  saveGoals([...byId.values()], market)
}

export function sentKey(market: Market, fixtureId: string, alertId: string): string {
  return market === 'goals'
    ? `${fixtureId}:${alertId}`
    : `${market}:${fixtureId}:${alertId}`
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
