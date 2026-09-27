import type { OddsObservation } from './oddsObserve'
import type { LeagueRow, RoiRow, Tip } from './tips'
import type { RobobetQuote } from './robobet'
import type { TipOverlay, TipOverlayProposal } from './tipOverlay'
import type { LeagueTelegramFile } from './leagueTelegram'

export type OverlayPayload = {
  active: TipOverlay
  proposal: TipOverlayProposal | null
  defaults: TipOverlay
  note: string
  alertGate?: boolean
}

export type TipsPayload = {
  open: Tip[]
  settled: Tip[]
  roi: RoiRow[]
  leagues: LeagueRow[]
  quotes: RobobetQuote[]
  overlay?: OverlayPayload
  observations?: OddsObservation[]
  horizonLongCap: number
  telegramLeagues?: LeagueTelegramFile
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

export async function fetchTipOverlay(): Promise<OverlayPayload | null> {
  try {
    const res = await fetch('/api/tips/overlay')
    if (!res.ok) return null
    return (await res.json()) as OverlayPayload
  } catch {
    return null
  }
}

export async function proposeTipOverlay(overlay: TipOverlay): Promise<TipOverlayProposal> {
  const res = await fetch('/api/tips/overlay', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlay }),
  })
  if (!res.ok) throw new Error('Não foi possível gravar a proposta de overlay')
  return (await res.json()) as TipOverlayProposal
}

export async function patchTelegramLeague(body: {
  key: string
  market: 'goals' | 'corners'
  tg?: boolean
  auto?: boolean
  minRoi?: number
}): Promise<LeagueTelegramFile> {
  const res = await fetch('/api/tips/telegram-leagues', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error('Não foi possível gravar o filtro Telegram da liga')
  return (await res.json()) as LeagueTelegramFile
}

export async function applyTipOverlay(
  overlay: TipOverlay,
  id?: string,
): Promise<TipOverlayProposal> {
  const res = await fetch('/api/tips/overlay/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ overlay, id, confirm: true }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error || 'Overlay não aplicado — confirmação em falta')
  }
  return (await res.json()) as TipOverlayProposal
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
