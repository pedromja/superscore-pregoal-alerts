import type { AlertSettings, FeedAlert, Market, RuleId, Side } from './types'

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
  summary: LearnSummary
  settings: AlertSettings
  proposal: ParamVersion | null
  history: ParamVersion[]
  recentAlerts: LoggedAlert[]
  autoAfter: number
}

function withMarket(path: string, market?: Market): string {
  if (!market) return path
  const sep = path.includes('?') ? '&' : '?'
  return `${path}${sep}market=${encodeURIComponent(market)}`
}

export async function fetchLearn(market?: Market): Promise<LearnPayload> {
  const res = await fetch(withMarket('/api/learn/summary', market))
  if (!res.ok) throw new Error('API de aprendizagem indisponível')
  return (await res.json()) as LearnPayload
}

export async function postAlerts(
  alerts: FeedAlert[],
  market?: Market,
): Promise<void> {
  if (!alerts.length) return
  const m = market ?? alerts[0]?.market
  await fetch(withMarket('/api/learn/alerts', m), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alerts),
  })
}

export async function postFeedback(
  id: string,
  feedback: 'up' | 'down' | null,
  market?: Market,
): Promise<void> {
  const res = await fetch(withMarket('/api/learn/feedback', market), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, feedback, market }),
  })
  if (!res.ok) throw new Error('Feedback não gravado')
}

export async function recalculateLearn(market?: Market): Promise<ParamVersion> {
  const res = await fetch(withMarket('/api/learn/recalculate', market), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'manual', market }),
  })
  if (!res.ok) throw new Error('Recálculo falhou')
  return (await res.json()) as ParamVersion
}

export async function applyLearnProposal(
  id: string,
  market?: Market,
): Promise<ParamVersion> {
  const res = await fetch(withMarket('/api/learn/apply', market), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, market }),
  })
  if (!res.ok) throw new Error('Não foi possível aplicar')
  return (await res.json()) as ParamVersion
}

export async function seedLearnDemos(market?: Market): Promise<void> {
  const res = await fetch(withMarket('/api/learn/seed-demos', market), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ market }),
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
