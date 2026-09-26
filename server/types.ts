import type { BetOutcome } from '../src/lib/betOutcome.ts'
import type { OddsObservation } from '../src/lib/oddsObserve.ts'
import type {
  AlertOverlay,
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
  /** Chat the live Telegram alert went to (edits target chat_id + message_id). */
  telegramChatId?: string
  /** Wall-clock ISO time the live Telegram alert was delivered. */
  telegramSentAt?: string
  /** What the feed showed when the alert was sent (VOID re-check baseline). */
  sendSnapshot?: AlertSendSnapshot
  /** Last VOID re-check (audit trail, also when the alert stayed valid). */
  voidCheck?: VoidCheckRecord
  /**
   * Line already beaten when the alert was sent. Kept for audit but excluded
   * from every counted stat (precision/overlay/tips ROI/league) and never
   * gets a GREEN/RED outcome.
   */
  void?: boolean
  voidReason?: string
  voidAt?: string
  odds?: OddsObservation
  /**
   * Bet outcome (+0.5 on the market total, both teams, to the end of the half
   * incl. stoppage). Drives Telegram GREEN/RED and every counted stat; the
   * learning labels (hit5/hitLong) stay separate. Absent while pending.
   */
  betOutcome?: BetOutcome
  /** Quality overlay decision; absent on alerts stored before the overlay. */
  overlay?: AlertOverlay
}

export type AlertSendSnapshot = {
  /** Wall-clock ISO time of the successful send. */
  sentAt: string
  /** Latest momentum clock in the payload the alert was sent from. */
  clockMin: number | null
  clockPeriod: number | null
  /** Market events (goals type 4 / corners type 14) at the alert minute = score in the message. */
  totalAtAlert: number
}

export type VoidCheckResult = 'void' | 'clean' | 'same-minute' | 'no-data'

export type VoidCheckRecord = {
  checkedAt: string
  result: VoidCheckResult
  source: 'superscore-fresh' | 'superscore-stored' | 'none'
  /** Market events strictly before the send clock minute in the fresh feed. */
  totalBeforeSend: number | null
  totalAtAlert: number
  /** Event that beat the line (VOID) or the same-minute event (ambiguous). */
  event?: { min: number; period: number; side: 'home' | 'away' } | null
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

export type BetSummary = {
  settled: number
  green: number
  red: number
  pending: number
  voided: number
  hitRate: number | null
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
  /** GREEN/RED by the bet rule (end of the half), VOID excluded. */
  bet?: BetSummary
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
  /** Duration of the per-tick bet-outcome settle batch (ms). */
  lastBetSettleMs?: number
  lastFixtureError: PollerFixtureError | null
  liveProcessed: number
  pushSubscribers: number
  webPushEnabled: boolean
  telegram: {
    configured: boolean
    enabled: boolean
    lastSendAt: string | null
    lastError: string | null
  }
}
