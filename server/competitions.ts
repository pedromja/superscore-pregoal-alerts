/**
 * Competition registry: fixture → unique league key (+ display label).
 *
 * - Live fixtures carry SuperScore's competition id (flattenFixtures) ⇒ `id:`.
 * - Stored matches from before the id was kept are backfilled once at boot
 *   from the SuperScore fixtures-by-date feed of their day, into the sidecar
 *   `data/competitions.json` (match files are not rewritten).
 * - Still without an id: country + name (`cn:`), unless that country+name is
 *   known to belong to several competitions (ambiguous ⇒ not counted); when
 *   it maps to exactly one known competition, that id is used.
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  competitionPairKey,
  leagueDisplayLabel,
  type CompetitionInfo,
} from '../src/lib/leagueKey.ts'
import { DATA_DIR } from './config.ts'

export type FixtureCompetition = CompetitionInfo & { fixtureId: string; dateSeconds?: number }
export type ResolvedLeague = { key: string; label: string }

type Sidecar = {
  version: 1
  fixtures: Record<string, { competitionId: string; category: string; competition: string }>
  fetchedDates: string[]
}

const fixtures = new Map<string, FixtureCompetition>()
const pairIds = new Map<string, Set<string>>()
const idLabel = new Map<string, string>()
let sidecar: Sidecar | null = null

function sidecarPath(): string {
  return join(DATA_DIR, 'competitions.json')
}

function loadSidecar(): Sidecar {
  if (sidecar) return sidecar
  try {
    if (existsSync(sidecarPath())) {
      const raw = JSON.parse(readFileSync(sidecarPath(), 'utf8')) as Partial<Sidecar>
      sidecar = { version: 1, fixtures: raw.fixtures ?? {}, fetchedDates: raw.fetchedDates ?? [] }
    }
  } catch {
    sidecar = null
  }
  sidecar ??= { version: 1, fixtures: {}, fetchedDates: [] }
  for (const row of Object.values(sidecar.fixtures)) registerId(row.competitionId, row)
  return sidecar
}

function saveSidecar(): void {
  if (!sidecar) return
  const tmp = `${sidecarPath()}.tmp`
  writeFileSync(tmp, JSON.stringify(sidecar))
  renameSync(tmp, sidecarPath())
}

function registerId(id: string | null | undefined, info: CompetitionInfo): void {
  if (!id) return
  const pair = competitionPairKey(info)
  if (pair) {
    const set = pairIds.get(pair) ?? new Set<string>()
    set.add(id)
    pairIds.set(pair, set)
  }
  if (!idLabel.has(id)) idLabel.set(id, leagueDisplayLabel(info))
}

/** Remember a fixture's competition (live fixture or stored snapshot). */
export function noteFixtureCompetition(info: FixtureCompetition): void {
  if (!info.fixtureId) return
  loadSidecar()
  const prev = fixtures.get(info.fixtureId)
  const merged: FixtureCompetition = {
    ...prev,
    ...info,
    competitionId: info.competitionId || prev?.competitionId || sidecar?.fixtures[info.fixtureId]?.competitionId || null,
  }
  fixtures.set(info.fixtureId, merged)
  registerId(merged.competitionId, merged)
}

/** Unique league of a fixture, or null (unknown / ambiguous name). */
export function resolveFixtureLeague(fixtureId: string, fallback?: CompetitionInfo): ResolvedLeague | null {
  loadSidecar()
  const info: CompetitionInfo | undefined = fixtures.get(fixtureId) ?? fallback
  if (!info) return null
  const id = info.competitionId || sidecar?.fixtures[fixtureId]?.competitionId
  const label = leagueDisplayLabel(info)
  if (id) return { key: `id:${id}`, label }
  const pair = competitionPairKey(info)
  if (!pair) return null
  const ids = pairIds.get(pair)
  if (!ids || ids.size === 0) return { key: pair, label }
  if (ids.size === 1) {
    const only = [...ids][0]
    return { key: `id:${only}`, label: idLabel.get(only) ?? label }
  }
  return null
}

export function knownCompetitionFixtures(): FixtureCompetition[] {
  return [...fixtures.values()]
}

export function fixtureCompetitionOf(fixtureId: string): FixtureCompetition | null {
  return fixtures.get(fixtureId) ?? null
}

/** Read every stored match snapshot's competition (async, yields). */
export async function loadStoredCompetitions(matchesDir: string): Promise<number> {
  loadSidecar()
  let files: string[] = []
  try {
    files = (await readdir(matchesDir)).filter((f) => f.endsWith('.json'))
  } catch {
    return 0
  }
  let n = 0
  for (const file of files) {
    try {
      const raw = JSON.parse(await readFile(join(matchesDir, file), 'utf8')) as {
        fixture?: { id?: string; competition?: string; category?: string; competitionId?: string | null; dateSeconds?: number }
      }
      const f = raw.fixture
      noteFixtureCompetition({
        fixtureId: f?.id ?? file.slice(0, -5),
        competitionId: f?.competitionId ?? null,
        category: f?.category ?? null,
        competition: f?.competition ?? null,
        dateSeconds: f?.dateSeconds,
      })
      n += 1
    } catch {
      // partial/corrupt snapshot
    }
  }
  return n
}

type FetchDay = (date: string) => Promise<{ id: string; competitionId?: string | null; category: string; competition: string }[]>

function lisbonDay(seconds: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(seconds * 1000))
}

/**
 * Backfill competition ids for stored fixtures that lack one, from the
 * fixtures-by-date feed of their (Lisbon) day. One request per day, soft-fail.
 */
export async function backfillCompetitionIds(fetchDay: FetchDay, opts: { maxDays?: number } = {}): Promise<{
  missing: number
  filled: number
  days: number
  failedDays: number
}> {
  const side = loadSidecar()
  const missingByDay = new Map<string, string[]>()
  for (const [id, f] of fixtures) {
    if (f.competitionId || side.fixtures[id]) continue
    if (!f.dateSeconds) continue
    const day = lisbonDay(f.dateSeconds)
    const list = missingByDay.get(day) ?? []
    list.push(id)
    missingByDay.set(day, list)
  }
  const out = { missing: [...missingByDay.values()].reduce((n, l) => n + l.length, 0), filled: 0, days: 0, failedDays: 0 }
  const days = [...missingByDay.keys()].filter((d) => !side.fetchedDates.includes(d)).sort().slice(-(opts.maxDays ?? 14))
  for (const day of days) {
    out.days += 1
    let rows: Awaited<ReturnType<FetchDay>>
    try {
      rows = await fetchDay(day)
    } catch {
      out.failedDays += 1
      continue
    }
    const byId = new Map(rows.map((r) => [r.id, r]))
    for (const r of rows) registerId(r.competitionId, r)
    for (const id of missingByDay.get(day) ?? []) {
      const r = byId.get(id)
      if (!r?.competitionId) continue
      side.fixtures[id] = { competitionId: r.competitionId, category: r.category, competition: r.competition }
      const f = fixtures.get(id)
      if (f) {
        f.competitionId = r.competitionId
        if (!f.category) f.category = r.category
        registerId(r.competitionId, f)
      }
      out.filled += 1
    }
    if (!side.fetchedDates.includes(day)) side.fetchedDates.push(day)
  }
  if (out.filled || out.days) {
    try {
      saveSidecar()
    } catch (err) {
      console.warn('[league] competitions.json', err instanceof Error ? err.message : err)
    }
  }
  return out
}

export function resetCompetitionsForTests(): void {
  fixtures.clear()
  pairIds.clear()
  idLabel.clear()
  sidecar = null
}
