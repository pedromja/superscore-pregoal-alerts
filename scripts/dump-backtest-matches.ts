/**
 * Fetch finished SuperScore momentum dumps for offline backtest.
 * Reuses the live fixtures/momentum endpoints (region + Lisbon date).
 *
 * Usage: npx tsx scripts/dump-backtest-matches.ts
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { flattenFixtures } from '../src/lib/api.ts'
import type { Fixture, MomentumPayload } from '../src/lib/types.ts'

const ROOT = join(import.meta.dirname, '..')
const OUT_DIR = join(ROOT, 'backtest-data')
const MATCH_DIR = join(OUT_DIR, 'matches')
const EXISTING_DIR = join(ROOT, 'data', 'matches')

const START = '2026-09-08'
const END = '2026-09-18'
const REGIONS = ['ro', 'pt', 'uk']
const CONCURRENCY = 6

mkdirSync(MATCH_DIR, { recursive: true })

function datesInclusive(from: string, to: string): string[] {
  const out: string[] = []
  const cur = new Date(`${from}T12:00:00Z`)
  const last = new Date(`${to}T12:00:00Z`)
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

function isFinished(f: Fixture): boolean {
  return f.state === 2 || f.status >= 100 || f.scoreIsFt
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const text = await res.text()
  if (!text.trim()) throw new Error(`empty ${url}`)
  return JSON.parse(text)
}

async function fetchFixtures(date: string, region: string): Promise<Fixture[]> {
  const params = new URLSearchParams({
    language: 'en',
    date,
    timezone_offset: '1',
  })
  const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures/by-date/${region}?${params}`
  const raw = await fetchJson(url)
  return flattenFixtures(raw as Parameters<typeof flattenFixtures>[0])
}

async function fetchMomentum(id: string): Promise<MomentumPayload> {
  const url = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id=${encodeURIComponent(id)}`
  const raw = (await fetchJson(url)) as MomentumPayload
  if (!raw?.timeline?.length) throw new Error(`no timeline ${id}`)
  return raw
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i
      i += 1
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

type ManifestRow = {
  id: string
  date: string
  region: string
  team1: string
  team2: string
  competition: string
  source: 'fetch' | 'cache'
  timeline: number
  goals: number
  corners: number
}

async function main() {
  const byId = new Map<string, { fixture: Fixture; date: string; region: string }>()
  const dateList = datesInclusive(START, END)
  for (const region of REGIONS) {
    for (const date of dateList) {
      try {
        const list = await fetchFixtures(date, region)
        const finished = list.filter(isFinished)
        console.log(`${date} ${region}: ${list.length} jogos, ${finished.length} FT`)
        for (const fixture of finished) {
          if (!byId.has(fixture.id)) byId.set(fixture.id, { fixture, date, region })
        }
      } catch (err) {
        console.warn(`fixtures ${date} ${region}`, err instanceof Error ? err.message : err)
      }
    }
  }

  const rows: ManifestRow[] = []
  const ids = [...byId.keys()]
  let ok = 0
  let fail = 0
  await pool(ids, CONCURRENCY, async (id) => {
    const meta = byId.get(id)!
    const dest = join(MATCH_DIR, `${id}.json`)
    try {
      let payload: MomentumPayload
      let source: 'fetch' | 'cache' = 'fetch'
      const cached = join(EXISTING_DIR, `${id}.json`)
      if (existsSync(dest)) {
        payload = (JSON.parse(readFileSync(dest, 'utf8')) as { payload: MomentumPayload }).payload
        source = 'cache'
      } else if (existsSync(cached)) {
        const stored = JSON.parse(readFileSync(cached, 'utf8')) as {
          payload: MomentumPayload
        }
        payload = stored.payload
        source = 'cache'
      } else {
        payload = await fetchMomentum(id)
      }
      if (!payload.timeline?.length) throw new Error('empty timeline')
      const record = {
        fixture: meta.fixture,
        payload,
        finished: true,
        updatedAt: new Date().toISOString(),
        date: meta.date,
        region: meta.region,
      }
      writeFileSync(dest, JSON.stringify(record))
      rows.push({
        id,
        date: meta.date,
        region: meta.region,
        team1: meta.fixture.team1,
        team2: meta.fixture.team2,
        competition: meta.fixture.competition,
        source,
        timeline: payload.timeline.length,
        goals: payload.events.filter((e) => e.type === 4).length,
        corners: payload.events.filter((e) => e.type === 14).length,
      })
      ok += 1
      if (ok % 20 === 0) console.log(`gravados ${ok}/${ids.length}`)
    } catch (err) {
      fail += 1
      console.warn(`skip ${id}`, err instanceof Error ? err.message : err)
    }
  })

  const manifest = {
    generatedAt: new Date().toISOString(),
    timezone: 'Europe/Lisbon',
    dateFrom: START,
    dateTo: END,
    regions: REGIONS,
    matches: ok,
    skipped: fail,
    goals: rows.reduce((n, r) => n + r.goals, 0),
    corners: rows.reduce((n, r) => n + r.corners, 0),
    files: {
      matchesDir: 'backtest-data/matches/',
      demos: [
        'public/demo/celtic-ferenc-momentum.json',
        'public/demo/drava-bistrica-momentum.json',
      ],
      liveCache: 'data/matches/ (gitignored poller snapshots, reused when id matches)',
    },
    rows: rows.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id)),
  }
  writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2))
  console.log(
    `OK dump: ${ok} jogos, ${manifest.goals} golos, ${manifest.corners} cantos, skip ${fail}`,
  )
}

await main()
