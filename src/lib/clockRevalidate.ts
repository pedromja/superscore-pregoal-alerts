import {
  isPreferredLead,
  isUsableLead,
  MIN_LEAD_MIN,
  PREFERRED_LEAD_MAX,
  horizonOptionsForMarket,
  outcomeForAlert,
} from './horizons'
import { defaultsFor, MARKET_EVENT_TYPE, parseMarket } from './market'
import { evaluateAlerts, extractMarketEvents } from './rules'
import type {
  AlertSettings,
  CornerHalf,
  GoalEvent,
  Market,
  MomentumPayload,
} from './types'
import { inCornerWindow, inGoalsWindow, isStoppageClock } from './windows'

export type ClockSource = 'superscore' | 'sokkerpro'

export type LeadHist = Record<string, number>

export type ClockBucketMetrics = {
  matches: number
  events: number
  alerts: number
  alertsPerMatch: number
  hits: number
  preferredHits: number
  eventsHit: number
  precision: number | null
  precisionPreferred: number | null
  recall: number | null
  medianLead: number | null
  meanLead: number | null
  leadHist: LeadHist
  coincident: number
  leadLt1: number
}

export type ClockCompareRow = {
  market: Market
  half: CornerHalf
  old: ClockBucketMetrics
  neu: ClockBucketMetrics
  /** Alerts that were usable lead≥1 on SuperScore and become lead&lt;1 / coincident on SokkerPro. */
  collapsed: {
    count: number
    shareOfOldHits: number | null
    shareOfAlerts: number | null
  }
  medianLeadDelta: number | null
  precisionDelta: number | null
  precisionPreferredDelta: number | null
}

export type EventOffset = {
  side: GoalEvent['side']
  ssMin: number
  ssPeriod: number
  spMin: number
  spPeriod: number
  /** SuperScore minute − SokkerPro minute. Positive = SuperScore later (optimistic lead). */
  offset: number
}

export type ClockPairing = {
  paired: EventOffset[]
  unpairedSuperscore: number
  unpairedSokker: number
  medianOffset: number | null
  meanOffset: number | null
  lateShare: number | null
}

export type SensitivityRow = {
  delayMin: number
  alerts: number
  oldHits: number
  newHits: number
  oldPrecision: number | null
  newPrecision: number | null
  oldPreferred: number
  newPreferred: number
  oldPrecisionPreferred: number | null
  newPrecisionPreferred: number | null
  collapsed: number
  collapsedShare: number | null
  medianLeadOld: number | null
  medianLeadNew: number | null
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

function mean(xs: number[]): number | null {
  if (!xs.length) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function pct(num: number, den: number): number | null {
  if (!den) return null
  return num / den
}

function emptyMetrics(matches: number): ClockBucketMetrics {
  return {
    matches,
    events: 0,
    alerts: 0,
    alertsPerMatch: 0,
    hits: 0,
    preferredHits: 0,
    eventsHit: 0,
    precision: null,
    precisionPreferred: null,
    recall: null,
    medianLead: null,
    meanLead: null,
    leadHist: {},
    coincident: 0,
    leadLt1: 0,
  }
}

function sameClock(
  a: Pick<GoalEvent, 'min' | 'period' | 'side'>,
  b: Pick<GoalEvent, 'min' | 'period' | 'side'>,
): boolean {
  return a.period === b.period && a.min === b.min && a.side === b.side
}

export function leadOfAlert(
  alert: { min: number; period: number; side: GoalEvent['side'] },
  events: GoalEvent[],
  points: { period: number; min: number }[],
  market: Market,
  half: CornerHalf,
): { lead: number | null; coincident: boolean; usable: boolean; preferred: boolean } {
  const horizon = horizonOptionsForMarket(market, half)
  const coincident = events.some((event) => sameClock(event, alert))
  const out = outcomeForAlert(
    { ...alert, coincident },
    events,
    points,
    horizon,
  )
  const lead = isUsableLead(out.leadTime5)
    ? out.leadTime5
    : isUsableLead(out.leadTimeLong)
      ? out.leadTimeLong
      : out.leadTime5 ?? out.leadTimeLong
  const usable = isUsableLead(out.leadTime5) || isUsableLead(out.leadTimeLong)
  return {
    lead,
    coincident,
    usable,
    preferred: usable && isPreferredLead(isUsableLead(out.leadTime5) ? out.leadTime5 : out.leadTimeLong),
  }
}

export function metricsFromAlerts(args: {
  matches: number
  alerts: Array<{ min: number; period: number; side: GoalEvent['side'] }>
  events: GoalEvent[]
  points: { period: number; min: number }[]
  market: Market
  half: CornerHalf
}): ClockBucketMetrics {
  const { matches, alerts, events, points, market, half } = args
  const horizon = horizonOptionsForMarket(market, half)
  const leads: number[] = []
  const leadHist: LeadHist = {}
  let hits = 0
  let preferredHits = 0
  let coincident = 0
  let leadLt1 = 0
  let eventsHit = 0
  const lite = alerts.map((a) => ({ ...a, coincident: false }))

  for (const alert of alerts) {
    const row = leadOfAlert(alert, events, points, market, half)
    if (row.coincident) coincident += 1
    if (row.usable) {
      hits += 1
      leads.push(row.lead as number)
      leadHist[String(row.lead)] = (leadHist[String(row.lead)] ?? 0) + 1
      if (row.preferred) preferredHits += 1
    } else if (row.lead === 0 || row.coincident) {
      leadHist['0'] = (leadHist['0'] ?? 0) + 1
      leadLt1 += 1
    } else if (typeof row.lead === 'number' && row.lead > 0 && row.lead < MIN_LEAD_MIN) {
      leadLt1 += 1
    }
  }

  for (const event of events) {
    const pre = lite.some((alert) => {
      if (alert.side !== event.side) return false
      const out = outcomeForAlert(alert, [event], points, horizon)
      return isUsableLead(out.leadTime5) || isUsableLead(out.leadTimeLong)
    })
    if (pre) eventsHit += 1
  }

  const n = Math.max(1, matches)
  return {
    matches,
    events: events.length,
    alerts: alerts.length,
    alertsPerMatch: alerts.length / n,
    hits,
    preferredHits,
    eventsHit,
    precision: pct(hits, alerts.length),
    precisionPreferred: pct(preferredHits, alerts.length),
    recall: pct(eventsHit, events.length),
    medianLead: median(leads),
    meanLead: mean(leads),
    leadHist,
    coincident,
    leadLt1,
  }
}

export type RevalidateMatch = {
  payload: MomentumPayload
  sokkerEvents: GoalEvent[]
}

/**
 * SuperScore rules fire the alerts; event clock is swapped for SokkerPro.
 * Locked windows / thresholds are **read**, never written.
 */
export function revalidateBucket(
  dumps: RevalidateMatch[],
  market: Market,
  half: CornerHalf,
  settings: AlertSettings = defaultsFor(parseMarket(market), half),
): ClockCompareRow {
  const m = parseMarket(market)
  let old = emptyMetrics(dumps.length)
  let neu = emptyMetrics(dumps.length)
  let collapsedCount = 0
  let oldHitsForShare = 0

  for (const dump of dumps) {
    const { points, alerts: fired } = evaluateAlerts(dump.payload, settings)
    const inWindow = m === 'corners' ? inCornerWindow : inGoalsWindow
    const ssEvents = extractMarketEvents(dump.payload, points, m, half).filter(
      (event) => !isStoppageClock(event.min, event.period),
    )
    const spEvents = dump.sokkerEvents.filter(
      (event) =>
        !isStoppageClock(event.min, event.period) && inWindow(event.min, event.period, half),
    )
    const usable = fired.filter((alert) => {
      const same = ssEvents.some(
        (g) => g.period === alert.period && g.min === alert.min && g.side === alert.side,
      )
      return !same
    })
    const lite = usable.map((a) => ({ min: a.min, period: a.period, side: a.side }))
    const oldPart = metricsFromAlerts({
      matches: 1,
      alerts: lite,
      events: ssEvents,
      points,
      market: m,
      half,
    })
    const newPart = metricsFromAlerts({
      matches: 1,
      alerts: lite,
      events: spEvents,
      points,
      market: m,
      half,
    })
    old = mergeMetrics(old, oldPart)
    neu = mergeMetrics(neu, newPart)
    for (const alert of lite) {
      const before = leadOfAlert(alert, ssEvents, points, m, half)
      const after = leadOfAlert(alert, spEvents, points, m, half)
      if (before.usable) {
        oldHitsForShare += 1
        if (!after.usable || after.coincident) collapsedCount += 1
      }
    }
  }

  return {
    market: m,
    half,
    old,
    neu,
    collapsed: {
      count: collapsedCount,
      shareOfOldHits: pct(collapsedCount, oldHitsForShare),
      shareOfAlerts: pct(collapsedCount, old.alerts),
    },
    medianLeadDelta:
      old.medianLead !== null && neu.medianLead !== null
        ? neu.medianLead - old.medianLead
        : null,
    precisionDelta:
      old.precision !== null && neu.precision !== null ? neu.precision - old.precision : null,
    precisionPreferredDelta:
      old.precisionPreferred !== null && neu.precisionPreferred !== null
        ? neu.precisionPreferred - old.precisionPreferred
        : null,
  }
}

function mergeMetrics(acc: ClockBucketMetrics, part: ClockBucketMetrics): ClockBucketMetrics {
  const alerts = acc.alerts + part.alerts
  const matches = acc.matches
  const hits = acc.hits + part.hits
  const preferredHits = acc.preferredHits + part.preferredHits
  const events = acc.events + part.events
  const eventsHit = acc.eventsHit + part.eventsHit
  const leadHist: LeadHist = { ...acc.leadHist }
  for (const [k, v] of Object.entries(part.leadHist)) {
    leadHist[k] = (leadHist[k] ?? 0) + v
  }
  const leads: number[] = []
  for (const [k, v] of Object.entries(leadHist)) {
    const n = Number(k)
    if (n >= MIN_LEAD_MIN) {
      for (let i = 0; i < v; i += 1) leads.push(n)
    }
  }
  return {
    matches,
    events,
    alerts,
    alertsPerMatch: alerts / Math.max(1, matches),
    hits,
    preferredHits,
    eventsHit,
    precision: pct(hits, alerts),
    precisionPreferred: pct(preferredHits, alerts),
    recall: pct(eventsHit, events),
    medianLead: median(leads),
    meanLead: mean(leads),
    leadHist,
    coincident: acc.coincident + part.coincident,
    leadLt1: acc.leadLt1 + part.leadLt1,
  }
}

/** All SuperScore market events (not clipped to locked windows) — clock-offset study. */
export function rawSuperscoreEvents(
  payload: MomentumPayload,
  market: Market,
): GoalEvent[] {
  const type = MARKET_EVENT_TYPE[parseMarket(market)]
  return (payload.events ?? [])
    .filter((event) => event.type === type)
    .map((event, index) => ({
      min: event.min,
      period: event.period,
      side: (event.side === 2 ? 'away' : 'home') as GoalEvent['side'],
      index,
    }))
    .sort((a, b) => a.period - b.period || a.min - b.min)
}

export function pairEventClocks(
  superscore: GoalEvent[],
  sokker: GoalEvent[],
): ClockPairing {
  const paired: EventOffset[] = []
  let unpairedSuperscore = 0
  let unpairedSokker = 0
  for (const side of ['home', 'away'] as const) {
    const ss = superscore.filter((e) => e.side === side).sort((a, b) => a.period - b.period || a.min - b.min)
    const sp = sokker.filter((e) => e.side === side).sort((a, b) => a.period - b.period || a.min - b.min)
    const n = Math.min(ss.length, sp.length)
    for (let i = 0; i < n; i += 1) {
      paired.push({
        side,
        ssMin: ss[i].min,
        ssPeriod: ss[i].period,
        spMin: sp[i].min,
        spPeriod: sp[i].period,
        offset: ss[i].min - sp[i].min,
      })
    }
    unpairedSuperscore += ss.length - n
    unpairedSokker += sp.length - n
  }
  const offsets = paired.map((row) => row.offset)
  return {
    paired,
    unpairedSuperscore,
    unpairedSokker,
    medianOffset: median(offsets),
    meanOffset: mean(offsets),
    lateShare: pct(offsets.filter((n) => n >= 1).length, offsets.length),
  }
}

/**
 * Bound optimistic bias without SokkerPro: shift SuperScore event minutes
 * earlier by `delayMin` (as if the stamp arrived late by that many minutes).
 */
export function shiftEventsEarlier(events: GoalEvent[], delayMin: number): GoalEvent[] {
  if (delayMin <= 0) return events
  return events.map((event) => ({
    ...event,
    min: event.min - delayMin,
  }))
}

export function expandLeadHist(hist: LeadHist): number[] {
  const out: number[] = []
  for (const [key, count] of Object.entries(hist)) {
    const lead = Number(key)
    if (!Number.isFinite(lead) || count <= 0) continue
    for (let i = 0; i < count; i += 1) out.push(lead)
  }
  return out
}

/**
 * Apply a late SuperScore stamp of `delayMin` to a published lead histogram.
 * A reported lead L becomes L − delay. L &lt; delay+1 collapses to lead&lt;1.
 */
export function shiftPublishedLeadHist(
  hist: LeadHist,
  delayMin: number,
  alerts: number,
): SensitivityRow {
  const leads = expandLeadHist(hist).filter((n) => n >= MIN_LEAD_MIN)
  const oldHits = leads.length
  const oldPreferred = leads.filter((n) => n >= MIN_LEAD_MIN && n <= PREFERRED_LEAD_MAX).length
  const shifted = leads.map((n) => n - delayMin)
  const newHits = shifted.filter((n) => n >= MIN_LEAD_MIN).length
  const newPreferred = shifted.filter((n) => n >= MIN_LEAD_MIN && n <= PREFERRED_LEAD_MAX).length
  const collapsed = oldHits - newHits
  const usableNew = shifted.filter((n) => n >= MIN_LEAD_MIN)
  return {
    delayMin,
    alerts,
    oldHits,
    newHits,
    oldPrecision: pct(oldHits, alerts),
    newPrecision: pct(newHits, alerts),
    oldPreferred,
    newPreferred,
    oldPrecisionPreferred: pct(oldPreferred, alerts),
    newPrecisionPreferred: pct(newPreferred, alerts),
    collapsed,
    collapsedShare: pct(collapsed, oldHits),
    medianLeadOld: median(leads),
    medianLeadNew: median(usableNew),
  }
}

export type RecommendationAction =
  | 'keep'
  | 'tighten-notify-suppress'
  | 'propose-params-pending-pedro'

export type ClockRecommendation = {
  action: RecommendationAction
  lockedUntouched: true
  headlinePt: string
  detailPt: string[]
}

/**
 * Never unlocks windows/thresholds. Advice only.
 */
export function recommendClockFix(args: {
  matchedMatches: number
  medianOffset: number | null
  collapsedShare: number | null
  precisionDelta: number | null
  cornersLiveClock: 'none' | 'suspect'
  prospectiveReady: boolean
}): ClockRecommendation {
  const detailPt: string[] = [
    'Janelas e limiares locked **não** foram alterados. A aprendizagem continua só a propor.',
    'O gate ao vivo SokkerPro (PR #17) já barre Telegram quando o marcador rápido já bateu.',
  ]
  const collapsed = args.collapsedShare ?? 0
  const offset = args.medianOffset ?? 0
  const drop = args.precisionDelta === null ? 0 : -args.precisionDelta

  if (args.matchedMatches <= 0) {
    return {
      action: 'keep',
      lockedUntouched: true,
      headlinePt:
        'Manter locked. Sem relógio SokkerPro histórico emparelhado não se pode corrigir o backtest — só o estudo prospectivo.',
      detailPt: [
        ...detailPt,
        args.prospectiveReady
          ? 'Cada alerta ao vivo já grava o snapshot SokkerPro (`is_goal` / marcador) para calibrar daqui para a frente.'
          : 'Arrancar o logging prospectivo (score / is_goal em cada alerta) antes de falar em novos params.',
        args.cornersLiveClock === 'none'
          ? 'Cantos: o mini board não tem cantos. Relógio de cantos ao vivo continua SuperScore type=14 (ainda suspeito).'
          : 'Cantos históricos no `/fixture/{id}` existem, mas o feed ao vivo continua sem cantos rápidos.',
      ],
    }
  }

  if (offset < 1 && collapsed < 0.12 && drop < 0.05) {
    return {
      action: 'keep',
      lockedUntouched: true,
      headlinePt:
        'Manter locked. O desvio SuperScore↔SokkerPro no sample emparelhado é pequeno — não justifica mexer nas defs.',
      detailPt: [
        ...detailPt,
        `Offset mediano ${offset}′; ${(collapsed * 100).toFixed(0)}% dos acertos SuperScore colapsam para lead<1 no relógio SokkerPro.`,
        'O enviesamento optimista existe sobretudo no **atraso de chegada ao vivo**, já mitigado pelo gate — não no stamp do dump FT.',
        args.cornersLiveClock === 'none'
          ? 'Cantos ao vivo: sem feed rápido. Não reivindicar precisão@lead de cantos como ground-truth.'
          : '',
      ].filter(Boolean),
    }
  }

  if (offset >= 1 || collapsed >= 0.2 || drop >= 0.08) {
    return {
      action: 'tighten-notify-suppress',
      lockedUntouched: true,
      headlinePt:
        'Manter locked. Considerar apertar o suppress ao vivo (ex. MIN_NOTIFY_LEAD_MIN=2) — só com confirmação do Pedro. Não propor novos limiares ainda.',
      detailPt: [
        ...detailPt,
        `Offset mediano ${offset}′; ${(collapsed * 100).toFixed(0)}% dos hits SuperScore deixam de ter lead≥1 no relógio SokkerPro.`,
        'Isso invalida a leitura literal do backtest 18/set (prec@lead 1–2). Os params locked foram escolhidos nesse relógio — não os reescrever em silêncio.',
        'O gate SokkerPro já reduz Telegram tardio. Um piso de 2′ no notify (env) é a alavanca mais segura, sem tocar nas janelas.',
        'Novos params só depois do estudo prospectivo (log `is_goal` + transições de marcador) e confirmação explícita.',
        args.cornersLiveClock === 'none'
          ? 'Cantos: pular revalidação ao vivo até haver feed de cantos mais rápido. Histórico `/fixture/{id}` type=126 fica flagged still-suspect para o live.'
          : '',
      ].filter(Boolean),
    }
  }

  return {
    action: 'propose-params-pending-pedro',
    lockedUntouched: true,
    headlinePt:
      'Manter locked. Há enviesamento visível mas moderado — propor (não aplicar) params só depois do Pedro confirmar o estudo prospectivo.',
    detailPt: [
      ...detailPt,
      `Offset mediano ${offset}′; colapso ${(collapsed * 100).toFixed(0)}%. Precisão@lead SuperScore não deve ser citada como verdade operacional.`,
      'Não desbloquear janelas. Qualquer grelha nova tem de usar o relógio SokkerPro (golos) e deixar cantos em still-suspect.',
    ],
  }
}
