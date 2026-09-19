import type { AlertClockProbe } from '../src/lib/clockProbe.ts'
import type { FastScore } from '../src/lib/fastScore.ts'
import type { OddsObservation } from '../src/lib/oddsObserve.ts'
import type {
  AlertSettings,
  CornerHalf,
  Fixture,
  Market,
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
  market?: Market
  cornerHalf?: CornerHalf
  features: { v: number; delta1: number | null; sustained: number }
  thresholdsSnapshot: Partial<AlertSettings>
  ts: string
  coincident: boolean
  hit: boolean | null
  leadMin: number | null
  hit5: boolean | null
  hitLong: boolean | null
  longDeadline: number | null
  leadTime5: number | null
  leadTimeLong: number | null
  labeledAt: string | null
  feedback: 'up' | 'down' | null
  sentPush: boolean
  /** Bot API message_id of the live Telegram alert, if we captured it. */
  telegramMessageId?: number
  /** ISO timestamp after the GREEN/RED outcome notice was sent (idempotency). */
  telegramOutcomeSentAt?: string | null
  odds?: OddsObservation
  /** SokkerPro score / is_goal at fire time. Missing on historical SuperScore-only alerts. */
  fastScore?: FastScore | null
  clockProbe?: AlertClockProbe
}

export type GoalRecord = {
  fixtureId: string
  matchLabel: string
  period: number
  min: number
  index: number
  side: Side
  market?: Market
  cornerHalf?: CornerHalf
  hadPrealert: boolean | null
  leadMin: number | null
  hadPrealert5: boolean | null
  hadPrealertLong: boolean | null
  leadMin5: number | null
  leadMinLong: number | null
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

export type StoredMatch = {
  fixture: Fixture
  payload: MomentumPayload
  finished: boolean
  updatedAt: string
}

export type PollerFixtureError = {
  fixtureId: string
  matchLabel: string
  message: string
  at: string
}

export type AlertLatencyHint = {
  clockMin: number
  period: number
  sentAt: string
  tickLagMs: number
  matchLabel: string
  fixtureId: string
}

export type PollerStatus = {
  enabled: boolean
  region: string
  intervalMs: number
  lastTickAt: string | null
  lastError: string | null
  liveWatched: number
  inWindowThisTick: number
  lastAlertLatencyHint: AlertLatencyHint | null
  alertsSent: number
  tickInFlight: boolean
  lastTickDurationMs: number | null
  lastHangAt: string | null
  lastFixtureError: PollerFixtureError | null
  liveProcessed: number
  pushSubscribers: number
  webPushEnabled: boolean
  /** Telegram skipped because SokkerPro / latest SuperScore already showed the event. */
  suppressedAlreadyHit: number
  lastAlreadyHitReason: string | null
  telegram: {
    configured: boolean
    enabled: boolean
    lastSendAt: string | null
    lastError: string | null
  }
}
