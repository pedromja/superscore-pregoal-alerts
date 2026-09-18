import type {
  AlertSettings,
  CornerHalf,
  FeedAlert,
  Market,
  RuleId,
  Side,
} from './types'

export type RuleMetrics = {
  precision: number | null
  recall: number | null
  alerts: number
  labeled: number
  hits: number
  goals: number
  goalsHit: number
  alertsPerMatch: number
  medianLead: number | null
}

export type DualMetrics = {
  w5: RuleMetrics
  wLong: RuleMetrics
}

export type LearnSummary = {
  market?: Market
  half?: CornerHalf
  horizonShort: number
  horizonLongCap: number
  window: number
  matches: number
  global: DualMetrics
  byRule: Record<RuleId, DualMetrics>
  unlabeled: number
  lastRecalcAt: string | null
  scoreNote: string
}

export type ParamVersion = {
  id: string
  ts: string
  reason: string
  applied: boolean
  settings: AlertSettings
  before: DualMetrics
  after: DualMetrics
  score: number
  autoEligible: boolean
  note: string
}

export type LoggedAlert = {
  id: string
  fixtureId: string
  matchLabel: string
  minute: number
  period: number
  side: Side
  ruleId: RuleId
  market?: Market
  cornerHalf?: CornerHalf
  features: { v: number; delta1: number | null; sustained: number }
  hit: boolean | null
  hit5: boolean | null
  hitLong: boolean | null
  longDeadline: number | null
  leadMin: number | null
  leadTime5: number | null
  leadTimeLong: number | null
  feedback: 'up' | 'down' | null
  coincident: boolean
  ts: string
}

export type LearnPayload = {
  market?: Market
  half?: CornerHalf
  summary: LearnSummary
  settings: AlertSettings
  proposal: ParamVersion | null
  history: ParamVersion[]
  recentAlerts: LoggedAlert[]
  autoAfter: number
}

export type LearnCornersPayload = {
  market: 'corners'
  ht: LearnPayload
  ft: LearnPayload
}

function withQuery(
  path: string,
  params: { market?: Market; half?: CornerHalf },
): string {
  const search = new URLSearchParams()
  if (params.market) search.set('market', params.market)
  if (params.half) search.set('half', params.half)
  const q = search.toString()
  if (!q) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}${q}`
}

export function isCornersLearn(
  data: LearnPayload | LearnCornersPayload,
): data is LearnCornersPayload {
  return 'ht' in data && 'ft' in data
}

export async function fetchLearn(
  market?: Market,
  half?: CornerHalf,
): Promise<LearnPayload | LearnCornersPayload> {
  const res = await fetch(withQuery('/api/learn/summary', { market, half }))
  if (!res.ok) throw new Error('API de aprendizagem indisponível')
  return (await res.json()) as LearnPayload | LearnCornersPayload
}

export async function postAlerts(
  alerts: FeedAlert[],
  market?: Market,
  half?: CornerHalf,
): Promise<void> {
  if (!alerts.length) return
  const m = market ?? alerts[0]?.market
  const h = half ?? alerts[0]?.cornerHalf
  await fetch(withQuery('/api/learn/alerts', { market: m, half: h }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alerts),
  })
}

export async function postFeedback(
  id: string,
  feedback: 'up' | 'down' | null,
  market?: Market,
  half?: CornerHalf,
): Promise<void> {
  const res = await fetch(withQuery('/api/learn/feedback', { market, half }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, feedback, market, half }),
  })
  if (!res.ok) throw new Error('Feedback não gravado')
}

export async function recalculateLearn(
  market?: Market,
  half?: CornerHalf,
): Promise<ParamVersion> {
  const res = await fetch(withQuery('/api/learn/recalculate', { market, half }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'manual', market, half }),
  })
  if (!res.ok) throw new Error('Recálculo falhou')
  return (await res.json()) as ParamVersion
}

export async function applyLearnProposal(
  id: string,
  market?: Market,
  half?: CornerHalf,
): Promise<ParamVersion> {
  const res = await fetch(withQuery('/api/learn/apply', { market, half }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, market, half }),
  })
  if (!res.ok) throw new Error('Não foi possível aplicar')
  return (await res.json()) as ParamVersion
}

export async function seedLearnDemos(
  market?: Market,
  half?: CornerHalf,
): Promise<void> {
  const res = await fetch(withQuery('/api/learn/seed-demos', { market, half }), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market, half }),
  })
  if (!res.ok) throw new Error('Falha a importar amostras')
}

export async function putActiveMarket(market: Market): Promise<void> {
  await fetch('/api/learn/market', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market }),
  })
}

export async function fetchPollerStatus(): Promise<{
  enabled: boolean
  region: string
  intervalMs: number
  lastTickAt: string | null
  lastError: string | null
  liveWatched: number
  alertsSent: number
} | null> {
  try {
    const res = await fetch('/api/poller/status')
    if (!res.ok) return null
    return (await res.json()) as {
      enabled: boolean
      region: string
      intervalMs: number
      lastTickAt: string | null
      lastError: string | null
      liveWatched: number
      alertsSent: number
    }
  } catch {
    return null
  }
}
