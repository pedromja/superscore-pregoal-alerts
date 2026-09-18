import type { LeagueRow, RoiRow, Tip } from './tips'
import type { RobobetQuote } from './robobet'

export type TipsPayload = {
  open: Tip[]
  settled: Tip[]
  roi: RoiRow[]
  leagues: LeagueRow[]
  quotes: RobobetQuote[]
  horizonLongCap: number
}

export async function fetchTips(): Promise<TipsPayload | null> {
  try {
    const res = await fetch('/api/tips')
    if (!res.ok) return null
    return (await res.json()) as TipsPayload
  } catch {
    return null
  }
}

export async function postRobobetIngest(body: unknown): Promise<unknown> {
  const res = await fetch('/api/robobet/ingest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Ingest RoboBet falhou')
  return res.json()
}
