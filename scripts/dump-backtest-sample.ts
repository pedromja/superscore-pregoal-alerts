/**
 * Fill remaining Lisbon dates (12–18 Set) with a stratified sample.
 * Keeps existing backtest-data/matches dumps.
 */
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { flattenFixtures } from '../src/lib/api.ts'
import type { Fixture, MomentumPayload } from '../src/lib/types.ts'

const ROOT = join(import.meta.dirname, '..')
const MATCH_DIR = join(ROOT, 'backtest-data', 'matches')
mkdirSync(MATCH_DIR, { recursive: true })

const DATES = [
  '2026-09-12',
  '2026-09-13',
  '2026-09-14',
  '2026-09-15',
  '2026-09-16',
  '2026-09-17',
  '2026-09-18',
]
const REGION = 'ro'
const PER_DAY = 40

function isFinished(f: Fixture): boolean {
  return f.state === 2 || f.status >= 100 || f.scoreIsFt
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
  })
  if (!res.ok) throw new Error(`${res.status}`)
  const text = await res.text()
  if (!text.trim()) throw new Error('empty')
  return JSON.parse(text)
}

function hashId(id: string): number {
  let h = 0
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) >>> 0
  return h
}

async function main() {
  const existing = new Set(
    readdirSync(MATCH_DIR)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.replace(/\.json$/, '')),
  )
  let added = 0
  for (const date of DATES) {
    const params = new URLSearchParams({
      language: 'en',
      date,
      timezone_offset: '1',
    })
    const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures/by-date/${REGION}?${params}`
    const list = flattenFixtures(
      (await fetchJson(url)) as Parameters<typeof flattenFixtures>[0],
    ).filter(isFinished)
    const ranked = [...list].sort((a, b) => {
      const scoreA = (a.scoreHome ?? 0) + (a.scoreAway ?? 0)
      const scoreB = (b.scoreHome ?? 0) + (b.scoreAway ?? 0)
      if (scoreB !== scoreA) return scoreB - scoreA
      return hashId(a.id) - hashId(b.id)
    })
    let dayOk = 0
    for (const fixture of ranked) {
      if (dayOk >= PER_DAY) break
      if (existing.has(fixture.id)) continue
      try {
        const momentumUrl = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id=${encodeURIComponent(fixture.id)}`
        const payload = (await fetchJson(momentumUrl)) as MomentumPayload
        if ((payload.timeline?.length ?? 0) < 80) continue
        writeFileSync(
          join(MATCH_DIR, `${fixture.id}.json`),
          JSON.stringify({
            fixture,
            payload,
            finished: true,
            updatedAt: new Date().toISOString(),
            date,
            region: REGION,
          }),
        )
        existing.add(fixture.id)
        dayOk += 1
        added += 1
      } catch {
        /* skip */
      }
    }
    console.log(`${date}: +${dayOk} (total ${existing.size})`)
  }
  console.log(`added ${added}`)
}

await main()
