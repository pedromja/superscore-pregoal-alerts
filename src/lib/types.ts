export type Side = 'home' | 'away'
export type RuleId = 'primary' | 'secondary' | 'fallback'
export type TabId = 'monitor' | 'replay' | 'definicoes' | 'aprendizagem'

export type AlertSettings = {
  spikeThreshold: number
  swingComboThreshold: number
  swingSecondaryThreshold: number
  sustainedThreshold: number
  sustainedComboMinutes: number
  sustainedFallbackMinutes: number
  enablePrimary: boolean
  enableSecondary: boolean
  enableFallback: boolean
  evaluationWindow: number
  notificationsEnabled: boolean
  notifyPrimary: boolean
  notifySecondary: boolean
  notifyFallback: boolean
}

export type RawTimelineRow = {
  min: number
  period: number
  value: { value: number }
}

export type RawMomentumEvent = {
  type: number
  subtype?: number
  side: number
  min: number
  period: number
}

export type MomentumPayload = {
  timeline: RawTimelineRow[]
  events: RawMomentumEvent[]
  team1_id?: { value: string } | string
  team2_id?: { value: string } | string
}

export type TimelinePoint = {
  index: number
  min: number
  period: number
  value: number
  delta1: number | null
  absValue: number
  absDelta1: number | null
  side: Side | null
  sustainedLength: number
}

export type AlertSignals = {
  spike: boolean
  swingCombo: boolean
  swingSecondary: boolean
  sustainedCombo: boolean
  sustainedFallback: boolean
}

export type FiredAlert = {
  id: string
  rule: RuleId
  ruleName: string
  min: number
  period: number
  index: number
  side: Side
  momentum: number
  delta1: number | null
  sustainedLength: number
  signals: AlertSignals
}

export type GoalEvent = {
  min: number
  period: number
  side: Side
  index: number
}

export type LinkedAlert = FiredAlert & {
  leadMin: number
  coincident: boolean
  inWindow: boolean
}

export type GoalReplay = {
  goal: GoalEvent
  goalNumber: number
  scoreAfter: { home: number; away: number }
  preAlerts: LinkedAlert[]
  coincidentAlerts: LinkedAlert[]
  hit: boolean
  bestLead: number | null
}

export type ReplayResult = {
  points: TimelinePoint[]
  alerts: FiredAlert[]
  goals: GoalEvent[]
  perGoal: GoalReplay[]
  coincidentAlerts: FiredAlert[]
  goalsHit: number
  medianLead: number | null
}

export type Fixture = {
  id: string
  team1: string
  team2: string
  team1Id: string
  team2Id: string
  competition: string
  category: string
  status: number
  state: number
  dateSeconds: number
  liveElapsedSeconds: number | null
  scoreHome: number | null
  scoreAway: number | null
  scoreIsFt: boolean
}

export type DemoMatch = {
  id: string
  fixtureId: string | null
  team1: string
  team2: string
  competition: string
  date: string
  scoreHome: number
  scoreAway: number
  file: string
  note: string
}

export type FeedAlert = FiredAlert & {
  fixtureId: string
  matchLabel: string
  firedAt: string
  coincident: boolean
}
