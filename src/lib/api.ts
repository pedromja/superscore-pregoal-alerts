import type { Fixture, MomentumPayload } from './types'

type RawTeam = {
  name: string
  id: string
}

type RawScore = {
  team1: number
  team2: number
  type: number
}

type RawOdd = {
  outcome_id?: number
  price?: number
  uuid?: string
  event_id?: number
  name?: string
}

type RawMatch = {
  id: string
  status: number
  state: number
  date?: { seconds: number }
  live_minute?: { elapsed_seconds?: number } | null
  scores?: RawScore[]
  team1: RawTeam
  team2: RawTeam
  odds?: RawOdd[]
  offer_id?: string | null
}

type RawCompetitionBlock = {
  competition: { name: string; id?: string }
  category: { name: string; id?: string }
  matches: RawMatch[]
}

type FixturesResponse = {
  competitions?: RawCompetitionBlock[]
}

function pickScore(scores: RawScore[] | undefined): {
  home: number | null
  away: number | null
  ft: boolean
} {
  if (!scores?.length) return { home: null, away: null, ft: false }
  const ft = scores.find((s) => s.type === 0)
  if (ft) return { home: ft.team1, away: ft.team2, ft: true }
  const current = scores.find((s) => s.type === 6) ?? scores[0]
  return { home: current.team1, away: current.team2, ft: false }
}

export function flattenFixtures(data: FixturesResponse): Fixture[] {
  const out: Fixture[] = []
  for (const block of data.competitions ?? []) {
    for (const match of block.matches ?? []) {
      const score = pickScore(match.scores)
      out.push({
        id: match.id,
        team1: match.team1.name,
        team2: match.team2.name,
        team1Id: match.team1.id,
        team2Id: match.team2.id,
        competition: block.competition.name,
        category: block.category.name,
        competitionId: block.competition.id != null ? String(block.competition.id) : null,
        status: match.status,
        state: match.state,
        dateSeconds: match.date?.seconds ?? 0,
        liveElapsedSeconds: match.live_minute?.elapsed_seconds ?? null,
        scoreHome: score.home,
        scoreAway: score.away,
        scoreIsFt: score.ft,
        oddsEventId: match.odds?.[0]?.event_id ?? null,
      })
    }
  }
  return out.sort((a, b) => {
    const rank = (f: Fixture) => (f.state === 1 ? 0 : f.state === 0 ? 1 : 2)
    const d = rank(a) - rank(b)
    if (d !== 0) return d
    return a.dateSeconds - b.dateSeconds
  })
}

export async function fetchFixtures(
  date: string,
  region = 'ro',
): Promise<Fixture[]> {
  const params = new URLSearchParams({
    language: 'en',
    date,
    timezone_offset: '1',
  })
  const res = await fetch(`/api/ss-fixtures/by-date/${region}?${params}`)
  if (!res.ok) {
    throw new Error(`Jogos indisponíveis (${res.status})`)
  }
  const data = (await res.json()) as FixturesResponse
  return flattenFixtures(data)
}

export async function fetchMomentum(fixtureId: string): Promise<MomentumPayload> {
  const res = await fetch(
    `/api/ss-momentum?fixture-id=${encodeURIComponent(fixtureId)}`,
  )
  if (!res.ok) {
    throw new Error(`Momentum indisponível (${res.status})`)
  }
  return (await res.json()) as MomentumPayload
}

export async function fetchDemoMomentum(file: string): Promise<MomentumPayload> {
  const res = await fetch(file)
  if (!res.ok) throw new Error('Amostra local em falta')
  return (await res.json()) as MomentumPayload
}
