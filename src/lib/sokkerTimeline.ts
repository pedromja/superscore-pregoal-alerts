import type { GoalEvent, Side } from './types'

/**
 * SokkerPro `/fixture/{id}` timeline (JSON string or array).
 *
 * SuperScore uses `type=4` golos / `type=14` cantos.
 * SokkerPro uses **different** ids: `14` golo, `16` penálti, `126` canto.
 * Never mix the two taxonomies.
 *
 * The public mini board has **no** event list and **no** corner counts — only
 * live score / `is_goal`. Historical minutes live on the fixture-detail
 * `timeline` field (and `last_goal_timestamp` for the last golo only).
 */
export const SOKKER_TYPE_GOAL = 14
export const SOKKER_TYPE_PENALTY = 16
export const SOKKER_TYPE_CORNER = 126

export type SokkerTimelineKind = 'goal' | 'corner' | 'other'

export type SokkerTimelineEvent = {
  typeId: number
  kind: SokkerTimelineKind
  minute: number
  period: 1 | 2
  extraMinute: number | null
  minuteTotal: number
  side: Side | null
  participantId: string | null
  addition: string
  result: string | null
}

export type SokkerFixtureDetail = {
  fixtureId: string
  localTeamName: string
  visitorTeamName: string
  localTeamId: string | null
  visitorTeamId: string | null
  scoresLocalTeam: number | null
  scoresVisitorTeam: number | null
  lastGoalTimestamp: number | null
  lastGoalSide: Side | null
  timeline: SokkerTimelineEvent[]
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function str(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return ''
}

function num(value: unknown): number | null {
  if (value == null || value === '') return null
  const raw = typeof value === 'string' ? value.replace(/"/g, '').trim() : value
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

export function parseSokkerTypeId(value: unknown): number | null {
  const n = num(value)
  return n === null ? null : n
}

export function classifySokkerTimelineKind(
  typeId: number,
  addition = '',
): SokkerTimelineKind {
  const add = addition.toLowerCase()
  if (typeId === SOKKER_TYPE_CORNER || /\bcorners?\b/.test(add)) return 'corner'
  if (
    typeId === SOKKER_TYPE_GOAL ||
    typeId === SOKKER_TYPE_PENALTY ||
    /\b(goal|golo|penalty|penálti|own\s*goal)\b/.test(add)
  ) {
    return 'goal'
  }
  return 'other'
}

/**
 * Map SokkerPro minute fields onto the SuperScore absolute clock
 * (`period` 1|2 + `min`, including stoppage as P1>45 / P2>90).
 */
export function sokkerClockOf(args: {
  minute?: unknown
  extraMinute?: unknown
  minuteTotal?: unknown
}): { min: number; period: 1 | 2; extraMinute: number | null; minuteTotal: number } | null {
  const regulation = num(args.minute)
  const extra = num(args.extraMinute)
  const total = num(args.minuteTotal)
  const min =
    total ??
    (regulation === null ? null : regulation + (extra && extra > 0 ? extra : 0))
  if (min === null) return null
  const period: 1 | 2 = regulation !== null && regulation <= 45 ? 1 : min <= 45 ? 1 : 2
  return {
    min,
    period,
    extraMinute: extra,
    minuteTotal: min,
  }
}

export function sideFromParticipant(
  participantId: unknown,
  localTeamId: unknown,
  visitorTeamId: unknown,
): Side | null {
  const part = str(participantId).trim()
  const local = str(localTeamId).trim()
  const visitor = str(visitorTeamId).trim()
  if (!part) return null
  if (local && part === local) return 'home'
  if (visitor && part === visitor) return 'away'
  return null
}

export function parseSokkerTimelineEvent(
  raw: unknown,
  localTeamId?: unknown,
  visitorTeamId?: unknown,
): SokkerTimelineEvent | null {
  const row = asRecord(raw)
  if (!row) return null
  const typeId = parseSokkerTypeId(row.type_id ?? row.typeId ?? row.type)
  if (typeId === null) return null
  const addition = str(row.addition ?? row.info)
  const clock = sokkerClockOf({
    minute: row.minute ?? row.min,
    extraMinute: row.extra_minute ?? row.extraMinute,
    minuteTotal: row.minute_total ?? row.minuteTotal,
  })
  if (!clock) return null
  return {
    typeId,
    kind: classifySokkerTimelineKind(typeId, addition),
    minute: clock.min,
    period: clock.period,
    extraMinute: clock.extraMinute,
    minuteTotal: clock.minuteTotal,
    side: sideFromParticipant(
      row.participant_id ?? row.participantId,
      localTeamId,
      visitorTeamId,
    ),
    participantId: str(row.participant_id ?? row.participantId).trim() || null,
    addition,
    result: str(row.result).trim() || null,
  }
}

export function parseSokkerTimeline(
  raw: unknown,
  localTeamId?: unknown,
  visitorTeamId?: unknown,
): SokkerTimelineEvent[] {
  let rows: unknown = raw
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (!trimmed) return []
    try {
      rows = JSON.parse(trimmed) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(rows)) return []
  const out: SokkerTimelineEvent[] = []
  for (const item of rows) {
    const event = parseSokkerTimelineEvent(item, localTeamId, visitorTeamId)
    if (event) out.push(event)
  }
  return out.sort(
    (a, b) => a.period - b.period || a.minute - b.minute || a.typeId - b.typeId,
  )
}

function unwrapDetail(raw: unknown): Record<string, unknown> | null {
  const root = asRecord(raw)
  if (!root) return null
  return asRecord(root.data) ?? root
}

export function parseSokkerFixtureDetail(raw: unknown): SokkerFixtureDetail | null {
  const row = unwrapDetail(raw)
  if (!row) return null
  const fixtureId = str(row.fixtureId ?? row.fixture_id ?? row.id).trim()
  const localTeamName = str(row.localTeamName ?? row.homeTeamName ?? row.home)
  const visitorTeamName = str(row.visitorTeamName ?? row.awayTeamName ?? row.away)
  if (!fixtureId || !localTeamName || !visitorTeamName) return null
  const localTeamId = str(row.localTeamId ?? row.local_team_id).trim() || null
  const visitorTeamId = str(row.visitorTeamId ?? row.visitor_team_id).trim() || null
  const lastSideRaw = str(row.last_goal_side ?? row.lastGoalSide).toLowerCase()
  const lastGoalSide: Side | null =
    lastSideRaw === 'home' || lastSideRaw === 'casa' || lastSideRaw === 'local'
      ? 'home'
      : lastSideRaw === 'away' || lastSideRaw === 'fora' || lastSideRaw === 'visitor'
        ? 'away'
        : null
  return {
    fixtureId,
    localTeamName,
    visitorTeamName,
    localTeamId,
    visitorTeamId,
    scoresLocalTeam: num(row.scoresLocalTeam ?? row.score_home_atual),
    scoresVisitorTeam: num(row.scoresVisitorTeam ?? row.score_away_atual),
    lastGoalTimestamp: num(row.last_goal_timestamp ?? row.lastGoalTimestamp),
    lastGoalSide,
    timeline: parseSokkerTimeline(row.timeline, localTeamId, visitorTeamId),
  }
}

export function flipSokkerSide(side: Side | null, swapped: boolean): Side | null {
  if (!side || !swapped) return side
  return side === 'home' ? 'away' : 'home'
}

/** SuperScore-oriented GoalEvent list (same shape as `extractMarketEvents`). */
export function sokkerEventsAsGoals(
  detail: Pick<SokkerFixtureDetail, 'timeline'>,
  kind: 'goal' | 'corner',
  swapped = false,
): GoalEvent[] {
  return detail.timeline
    .filter((event) => event.kind === kind)
    .map((event, index) => ({
      min: event.minute,
      period: event.period,
      side: flipSokkerSide(event.side, swapped) ?? 'home',
      index,
    }))
    .filter((event) => event.side === 'home' || event.side === 'away')
    .sort((a, b) => a.period - b.period || a.min - b.min)
}

export function hasSokkerEventTimeline(
  detail: Pick<SokkerFixtureDetail, 'timeline'> | null | undefined,
): boolean {
  return Boolean(detail?.timeline.some((event) => event.kind === 'goal' || event.kind === 'corner'))
}
