import type {
  AlertSettings,
  Fixture,
  MomentumPayload,
  RuleId,
  Side,
} from '../src/lib/types.ts'

export type PushSub = {
  endpoint: string
  keys: { p256dh: string; auth: string }
  createdAt: string
}

export type LoggedAlert = {
  id: string
  fixtureId: string
  matchLabel: string
  minute: number
  period: number
  index: number
  side: Side
  ruleId: RuleId
  features: { v: number; delta1: number | null; sustained: number }
  thresholdsSnapshot: Partial<AlertSettings>
  ts: string
  coincident: boolean
  hit: boolean | null
  leadMin: number | null
  labeledAt: string | null
  feedback: 'up' | 'down' | null
  sentPush: boolean
}

export type GoalRecord = {
  fixtureId: string
  matchLabel: string
  period: number
  min: number
  index: number
  side: Side
  hadPrealert: boolean | null
  leadMin: number | null
}

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

export type LearnSummary = {
  window: number
  matches: number
  global: RuleMetrics
  byRule: Record<RuleId, RuleMetrics>
  unlabeled: number
  lastRecalcAt: string | null
}

export type ParamVersion = {
  id: string
  ts: string
  reason: string
  applied: boolean
  settings: AlertSettings
  before: RuleMetrics
  after: RuleMetrics
  score: number
  autoEligible: boolean
  note: string
}

export type StoredMatch = {
  fixture: Fixture
  payload: MomentumPayload
  finished: boolean
  updatedAt: string
}

export type PollerStatus = {
  enabled: boolean
  region: string
  intervalMs: number
  lastTickAt: string | null
  lastError: string | null
  liveWatched: number
  alertsSent: number
}
