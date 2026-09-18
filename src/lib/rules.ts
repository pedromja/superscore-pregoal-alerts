import type {
  AlertSettings,
  AlertSignals,
  FiredAlert,
  GoalEvent,
  GoalReplay,
  LinkedAlert,
  MomentumPayload,
  ReplayResult,
  RuleId,
  Side,
  TimelinePoint,
} from './types'

export const DEFAULT_SETTINGS: AlertSettings = {
  spikeThreshold: 80,
  swingComboThreshold: 50,
  swingSecondaryThreshold: 60,
  sustainedThreshold: 30,
  sustainedComboMinutes: 3,
  sustainedFallbackMinutes: 4,
  enablePrimary: true,
  enableSecondary: true,
  enableFallback: true,
  evaluationWindow: 5,
}

export const RULE_LABELS: Record<RuleId, string> = {
  primary: 'Primária · Spike80 ∧ (Swing50 ∨ Sustained3)',
  secondary: 'Secundária · Swing |Δ1|≥60',
  fallback: 'Reserva · Sustained |v|≥30 ×4',
}

export const RULE_SHORT: Record<RuleId, string> = {
  primary: 'Primária',
  secondary: 'Secundária',
  fallback: 'Reserva',
}

export function sideOf(value: number): Side | null {
  if (value > 0) return 'home'
  if (value < 0) return 'away'
  return null
}

export function normalizeTimeline(
  payload: MomentumPayload,
  sustainedThreshold: number,
): TimelinePoint[] {
  const rows = [...payload.timeline].sort((a, b) => {
    if (a.period !== b.period) return a.period - b.period
    return a.min - b.min
  })

  const points: TimelinePoint[] = rows.map((row, index) => {
    const value = Number(row.value?.value ?? 0)
    const prev = index > 0 ? Number(rows[index - 1].value?.value ?? 0) : null
    const delta1 = prev === null ? null : value - prev
    return {
      index,
      min: row.min,
      period: row.period,
      value,
      delta1,
      absValue: Math.abs(value),
      absDelta1: delta1 === null ? null : Math.abs(delta1),
      side: sideOf(value),
      sustainedLength: 0,
    }
  })

  for (let i = 0; i < points.length; i += 1) {
    const side = points[i].side
    if (!side) {
      points[i].sustainedLength = 0
      continue
    }
    let length = 0
    for (let k = i; k >= 0; k -= 1) {
      const p = points[k]
      if (p.side !== side || p.absValue < sustainedThreshold) break
      length += 1
    }
    points[i].sustainedLength = length
  }

  return points
}

function signalsAt(point: TimelinePoint, settings: AlertSettings): AlertSignals {
  return {
    spike: point.absValue >= settings.spikeThreshold,
    swingCombo:
      point.absDelta1 !== null &&
      point.absDelta1 >= settings.swingComboThreshold,
    swingSecondary:
      point.absDelta1 !== null &&
      point.absDelta1 >= settings.swingSecondaryThreshold,
    sustainedCombo: point.sustainedLength >= settings.sustainedComboMinutes,
    sustainedFallback:
      point.sustainedLength >= settings.sustainedFallbackMinutes,
  }
}

export function evaluatePoint(
  point: TimelinePoint,
  settings: AlertSettings,
): FiredAlert[] {
  if (!point.side) return []
  const signals = signalsAt(point, settings)
  const alerts: FiredAlert[] = []

  const push = (rule: RuleId) => {
    alerts.push({
      id: `${rule}-${point.period}-${point.min}-${point.index}`,
      rule,
      ruleName: RULE_LABELS[rule],
      min: point.min,
      period: point.period,
      index: point.index,
      side: point.side as Side,
      momentum: point.value,
      delta1: point.delta1,
      sustainedLength: point.sustainedLength,
      signals,
    })
  }

  if (
    settings.enablePrimary &&
    signals.spike &&
    (signals.swingCombo || signals.sustainedCombo)
  ) {
    push('primary')
  }
  if (settings.enableSecondary && signals.swingSecondary) {
    push('secondary')
  }
  if (settings.enableFallback && signals.sustainedFallback) {
    push('fallback')
  }

  return alerts
}

export function evaluateAlerts(
  payload: MomentumPayload,
  settings: AlertSettings,
  upToIndex?: number,
): { points: TimelinePoint[]; alerts: FiredAlert[] } {
  const points = normalizeTimeline(payload, settings.sustainedThreshold)
  const limit = upToIndex === undefined ? points.length - 1 : upToIndex
  const alerts: FiredAlert[] = []
  for (const point of points) {
    if (point.index > limit) break
    alerts.push(...evaluatePoint(point, settings))
  }
  return { points, alerts }
}

export function extractGoals(
  payload: MomentumPayload,
  points: TimelinePoint[],
): GoalEvent[] {
  return payload.events
    .filter((event) => event.type === 4)
    .map((event) => {
      const side: Side = event.side === 2 ? 'away' : 'home'
      const exact = points.find(
        (p) => p.period === event.period && p.min === event.min,
      )
      const index =
        exact?.index ??
        points.findLast((p) =>
          p.period < event.period ||
          (p.period === event.period && p.min <= event.min),
        )?.index ??
        0
      return { min: event.min, period: event.period, side, index }
    })
    .sort((a, b) => a.index - b.index || a.period - b.period || a.min - b.min)
}

function linkAlert(alert: FiredAlert, goal: GoalEvent): LinkedAlert {
  const leadMin = goal.index - alert.index
  return {
    ...alert,
    leadMin,
    coincident: leadMin === 0,
    inWindow: leadMin >= 1 && leadMin <= 1000,
  }
}

export function evaluateReplay(
  payload: MomentumPayload,
  settings: AlertSettings,
): ReplayResult {
  const { points, alerts } = evaluateAlerts(payload, settings)
  const goals = extractGoals(payload, points)
  const window = settings.evaluationWindow

  const coincidentAlerts = alerts.filter((alert) =>
    goals.some(
      (goal) =>
        goal.index === alert.index &&
        goal.period === alert.period &&
        goal.min === alert.min,
    ),
  )

  let home = 0
  let away = 0
  const perGoal: GoalReplay[] = goals.map((goal, goalNumber) => {
    if (goal.side === 'home') home += 1
    else away += 1

    const linked = alerts
      .filter((alert) => alert.side === goal.side)
      .map((alert) => linkAlert(alert, goal))

    const coincident = linked.filter((a) => a.coincident)
    const preAlerts = linked.filter(
      (a) => a.leadMin >= 1 && a.leadMin <= window,
    )
    const uniqueLead = [...new Set(preAlerts.map((a) => a.leadMin))]
    const bestLead = uniqueLead.length ? Math.min(...uniqueLead) : null

    return {
      goal,
      goalNumber: goalNumber + 1,
      scoreAfter: { home, away },
      preAlerts,
      coincidentAlerts: coincident,
      hit: preAlerts.length > 0,
      bestLead,
    }
  })

  const leads = perGoal
    .map((g) => g.bestLead)
    .filter((n): n is number => n !== null)
    .sort((a, b) => a - b)
  const medianLead = leads.length
    ? leads[Math.floor((leads.length - 1) / 2)]
    : null

  return {
    points,
    alerts,
    goals,
    perGoal,
    coincidentAlerts,
    goalsHit: perGoal.filter((g) => g.hit).length,
    medianLead,
  }
}

export function isSameAlertKey(a: FiredAlert, b: FiredAlert): boolean {
  return (
    a.rule === b.rule &&
    a.period === b.period &&
    a.min === b.min &&
    a.index === b.index
  )
}
