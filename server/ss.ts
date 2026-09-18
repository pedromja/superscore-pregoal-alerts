import { flattenFixtures } from '../src/lib/api.ts'
import type { Fixture, MomentumPayload } from '../src/lib/types.ts'

export async function fetchFixturesServer(
  date: string,
  region: string,
): Promise<Fixture[]> {
  const params = new URLSearchParams({
    language: 'en',
    date,
    timezone_offset: '1',
  })
  const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures/by-date/${region}?${params}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Jogos ${res.status}`)
  return flattenFixtures(await res.json())
}

export async function fetchMomentumServer(
  fixtureId: string,
): Promise<MomentumPayload> {
  const url = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id=${encodeURIComponent(fixtureId)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Momentum ${res.status}`)
  return (await res.json()) as MomentumPayload
}

export function lisbonDate(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Lisbon',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}
