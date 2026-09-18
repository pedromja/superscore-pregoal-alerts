import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AlertSettings, Fixture, MomentumPayload } from '../src/lib/types.ts'
import { DATA_DIR, MATCHES_DIR } from './config.ts'
import type { GoalRecord, LoggedAlert, ParamVersion, PushSub, StoredMatch } from './types.ts'

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

export function loadSubscriptions(): PushSub[] {
  return readJson('subscriptions.json', [])
}

export function saveSubscriptions(items: PushSub[]): void {
  writeJson('subscriptions.json', items)
}

export function loadAlerts(): LoggedAlert[] {
  return readJson('alerts.json', [])
}

export function saveAlerts(items: LoggedAlert[]): void {
  writeJson('alerts.json', items)
}

export function loadGoals(): GoalRecord[] {
  return readJson('goals.json', [])
}

export function saveGoals(items: GoalRecord[]): void {
  writeJson('goals.json', items)
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

export function loadParams(): AlertSettings | null {
  return readJson<AlertSettings | null>('params.json', null)
}

export function saveParams(settings: AlertSettings): void {
  writeJson('params.json', settings)
}

export function loadHistory(): ParamVersion[] {
  return readJson('params_history.json', [])
}

export function saveHistory(items: ParamVersion[]): void {
  writeJson('params_history.json', items)
}

export function loadProposal(): ParamVersion | null {
  return readJson<ParamVersion | null>('proposal.json', null)
}

export function saveProposal(item: ParamVersion | null): void {
  writeJson('proposal.json', item)
}

export function saveMatch(match: StoredMatch): void {
  writeFileSync(
    join(MATCHES_DIR, `${match.fixture.id}.json`),
    JSON.stringify(match),
  )
}

export function loadMatch(fixtureId: string): StoredMatch | null {
  const path = join(MATCHES_DIR, `${fixtureId}.json`)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredMatch
  } catch {
    return null
  }
}

export function listMatches(): StoredMatch[] {
  if (!existsSync(MATCHES_DIR)) return []
  return readdirSync(MATCHES_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => loadMatch(name.replace(/\.json$/, '')))
    .filter((m): m is StoredMatch => m !== null)
}

export function upsertAlerts(incoming: LoggedAlert[]): LoggedAlert[] {
  const alerts = loadAlerts()
  const byId = new Map(alerts.map((a) => [a.id, a]))
  for (const item of incoming) {
    const prev = byId.get(item.id)
    byId.set(item.id, prev ? { ...item, ...prev, ...item, feedback: prev.feedback ?? item.feedback } : item)
  }
  const next = [...byId.values()]
  saveAlerts(next)
  return next
}

export function upsertGoals(incoming: GoalRecord[]): void {
  const goals = loadGoals()
  const key = (g: GoalRecord) => `${g.fixtureId}:${g.period}:${g.min}:${g.side}`
  const byId = new Map(goals.map((g) => [key(g), g]))
  for (const item of incoming) byId.set(key(item), { ...byId.get(key(item)), ...item })
  saveGoals([...byId.values()])
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
