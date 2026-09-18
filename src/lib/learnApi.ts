import type { AlertSettings, FeedAlert, RuleId, Side } from './types'

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
  summary: LearnSummary
  settings: AlertSettings
  proposal: ParamVersion | null
  history: ParamVersion[]
  recentAlerts: LoggedAlert[]
  autoAfter: number
}

export async function fetchLearn(): Promise<LearnPayload> {
  const res = await fetch('/api/learn/summary')
  if (!res.ok) throw new Error('API de aprendizagem indisponível')
  return (await res.json()) as LearnPayload
}

export async function postAlerts(alerts: FeedAlert[]): Promise<void> {
  if (!alerts.length) return
  await fetch('/api/learn/alerts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(alerts),
  })
}

export async function postFeedback(
  id: string,
  feedback: 'up' | 'down' | null,
): Promise<void> {
  const res = await fetch('/api/learn/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, feedback }),
  })
  if (!res.ok) throw new Error('Feedback não gravado')
}

export async function recalculateLearn(): Promise<ParamVersion> {
  const res = await fetch('/api/learn/recalculate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'manual' }),
  })
  if (!res.ok) throw new Error('Recálculo falhou')
  return (await res.json()) as ParamVersion
}

export async function applyLearnProposal(id: string): Promise<ParamVersion> {
  const res = await fetch('/api/learn/apply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (!res.ok) throw new Error('Não foi possível aplicar')
  return (await res.json()) as ParamVersion
}

export async function seedLearnDemos(): Promise<void> {
  const res = await fetch('/api/learn/seed-demos', { method: 'POST' })
  if (!res.ok) throw new Error('Falha a importar amostras')
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
