import { marketCopy, MARKET_EVENT_TYPE, parseMarket } from './market'
import { formatSigned, sideLabel } from './format'
import { RULE_SHORT } from './rules'
import type {
  FeedAlert,
  Market,
  MatchTally,
  MomentumPayload,
  RawMomentumEvent,
} from './types'

export function emptyTally(): MatchTally {
  return { home: 0, away: 0 }
}

export function formatScore(tally: MatchTally): string {
  return `${tally.home}-${tally.away}`
}

/** Compact lock-screen line: "Golos 1-0 · Cantos 3-2" */
export function formatTalliesLine(
  goals: MatchTally,
  corners: MatchTally,
): string {
  return `Golos ${formatScore(goals)} · Cantos ${formatScore(corners)}`
}

function eventAtOrBefore(
  event: RawMomentumEvent,
  min: number,
  period: number,
): boolean {
  if (event.period !== period) return event.period < period
  return event.min <= min
}

export function tallyEvents(
  payload: MomentumPayload,
  eventType: number,
  upTo: { min: number; period: number },
): MatchTally {
  const tally = emptyTally()
  for (const event of payload.events ?? []) {
    if (event.type !== eventType) continue
    if (!eventAtOrBefore(event, upTo.min, upTo.period)) continue
    if (event.side === 2) tally.away += 1
    else tally.home += 1
  }
  return tally
}

export function matchTalliesAt(
  payload: MomentumPayload,
  upTo: { min: number; period: number },
): { goals: MatchTally; corners: MatchTally } {
  return {
    goals: tallyEvents(payload, MARKET_EVENT_TYPE.goals, upTo),
    corners: tallyEvents(payload, MARKET_EVENT_TYPE.corners, upTo),
  }
}

export function withMatchTallies<T extends { min: number; period: number }>(
  alert: T,
  payload: MomentumPayload,
): T & { goalsTally: MatchTally; cornersTally: MatchTally } {
  const { goals, corners } = matchTalliesAt(payload, {
    min: alert.min,
    period: alert.period,
  })
  return { ...alert, goalsTally: goals, cornersTally: corners }
}

export function talliesLineOf(alert: Pick<FeedAlert, 'goalsTally' | 'cornersTally'>): string | null {
  if (!alert.goalsTally || !alert.cornersTally) return null
  return formatTalliesLine(alert.goalsTally, alert.cornersTally)
}

export function alertNotificationCopy(
  alert: FeedAlert,
): { title: string; body: string } {
  const market = parseMarket(alert.market)
  const copy = marketCopy(market)
  const rule = RULE_SHORT[alert.rule]
  const prefix = market === 'goals' ? rule : `${copy.pushPrefix} · ${rule}`
  const tallies = talliesLineOf(alert)
  const title = tallies ? `${prefix} · ${tallies}` : `${prefix} · ${alert.matchLabel}`
  const bodyBits = [
    tallies ? alert.matchLabel : null,
    `${alert.min}'`,
    sideLabel(alert.side),
    `v ${formatSigned(alert.momentum)}`,
  ].filter((bit): bit is string => Boolean(bit))
  return { title, body: bodyBits.join(' · ') }
}

export function sampleFeedAlert(market: Market = 'goals'): FeedAlert {
  return {
    id: 'primary-1-38-0',
    fixtureId: 'demo-teste',
    matchLabel: 'Celtic vs Ferencváros',
    firedAt: new Date().toISOString(),
    coincident: false,
    market,
    goalsTally: { home: 1, away: 0 },
    cornersTally: { home: 3, away: 2 },
    rule: 'primary',
    ruleName:
      market === 'corners'
        ? 'Primária · Spike60 ∧ (Swing40 ∨ Sustained3@25)'
        : 'Primária · Spike80 ∧ (Swing50 ∨ Sustained3)',
    min: 38,
    period: 1,
    index: 0,
    side: 'away',
    momentum: -61,
    delta1: -63,
    sustainedLength: 1,
    signals: {
      spike: false,
      swingCombo: true,
      swingSecondary: true,
      sustainedCombo: false,
      sustainedFallback: false,
      fallbackSpike: false,
      sustainedSecondary: false,
    },
  }
}
