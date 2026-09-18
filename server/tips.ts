import {
  HORIZON_LONG_CAP,
  horizonOptionsForHalf,
  longDeadlineMin,
  periodEndMin,
} from '../src/lib/horizons.ts'
import { parseMarket } from '../src/lib/market.ts'
import {
  quoteFromIngestBody,
  ROBOBET_MATCH_WINDOW_MS,
  ROBOBET_STORE_CAP,
  type RobobetIngestBody,
  type RobobetQuote,
} from '../src/lib/robobet.ts'
import { formatTalliesLine } from '../src/lib/tally.ts'
import {
  computeLeagueFollowup,
  computeRoi,
  ENTRY_LABELS,
  entryTypeOf,
  fixtureMatchesQuote,
  formatOddPt,
  halfOfAlert,
  TEAM_MATCH_MIN,
  tipPnl,
  type Tip,
} from '../src/lib/tips.ts'
import {
  DEFAULT_TIP_OVERLAY,
  normalizeTipOverlay,
  oddPassesOverlay,
  OVERLAY_NOTE,
  type OverlayDecision,
  type TipOverlay,
  type TipOverlayProposal,
} from '../src/lib/tipOverlay.ts'
import type {
  CornerHalf,
  FeedAlert,
  Fixture,
  GoalEvent,
  Market,
} from '../src/lib/types.ts'
import { cornerHalfOf } from '../src/lib/windows.ts'
import { resolveSuperScoreMaisUm } from './odds.ts'
import {
  appendTipSkip,
  loadRobobetQuotes,
  loadTipOverlay,
  loadTipOverlayProposal,
  loadTips,
  saveRobobetQuotes,
  saveTipOverlay,
  saveTipOverlayProposal,
  saveTips,
} from './store.ts'

export type ResolvedOdd = {
  odd: number
  line: number | null
  source: 'superscore' | 'robobet'
  sourceLabel: string
  league?: string | null
}

export function ingestRobobet(body: RobobetIngestBody): RobobetQuote {
  const quote = quoteFromIngestBody(body)
  const items = loadRobobetQuotes()
  items.push(quote)
  saveRobobetQuotes(items.slice(-ROBOBET_STORE_CAP))
  return quote
}

export function matchRobobetQuote(
  fixture: Fixture,
  market: Market,
  now = Date.now(),
): RobobetQuote | null {
  const cutoff = now - ROBOBET_MATCH_WINDOW_MS
  let best: { quote: RobobetQuote; score: number } | null = null
  for (const quote of loadRobobetQuotes()) {
    if (!quote.odd || quote.odd <= 1) continue
    const ts = Date.parse(quote.ts)
    if (!Number.isFinite(ts) || ts < cutoff) continue
    if (quote.market && quote.market !== market) continue
    const score = fixtureMatchesQuote(
      fixture.team1,
      fixture.team2,
      quote.home,
      quote.away,
    )
    if (score < TEAM_MATCH_MIN) continue
    if (!best || score > best.score || (score === best.score && ts > Date.parse(best.quote.ts))) {
      best = { quote, score }
    }
  }
  return best?.quote ?? null
}

export async function resolveTipOdd(args: {
  fixture: Fixture
  market: Market
  half: CornerHalf
  currentTotal: number
}): Promise<ResolvedOdd | null> {
  const ss = await resolveSuperScoreMaisUm({
    fixtureId: args.fixture.id,
    eventId: args.fixture.oddsEventId,
    market: args.market,
    half: args.half,
    currentTotal: args.currentTotal,
  })
  if (ss) {
    return {
      odd: ss.odd,
      line: ss.line,
      source: 'superscore',
      sourceLabel: `SuperScore · ${ss.marketName} · ${ss.outcomeName}`,
      league: args.fixture.competition,
    }
  }
  const rb = matchRobobetQuote(args.fixture, args.market)
  if (rb?.odd) {
    return {
      odd: rb.odd,
      line: rb.linha,
      source: 'robobet',
      sourceLabel: 'RoboBet · Odd Ao Vivo',
      league: rb.league ?? args.fixture.competition,
    }
  }
  return null
}

export function decideTipOverlay(
  market: Market,
  half: CornerHalf,
  odd: number | null,
  overlay: TipOverlay = loadTipOverlay(),
): OverlayDecision {
  return oddPassesOverlay(overlay, entryTypeOf(market, half), odd)
}

export function overlayPayload() {
  return {
    active: loadTipOverlay(),
    proposal: loadTipOverlayProposal(),
    defaults: DEFAULT_TIP_OVERLAY,
    note: OVERLAY_NOTE,
  }
}

export function proposeTipOverlay(
  raw: unknown,
  reason = 'manual',
): TipOverlayProposal {
  const overlay = normalizeTipOverlay(raw)
  const proposal: TipOverlayProposal = {
    id: `overlay-${Date.now()}`,
    ts: new Date().toISOString(),
    reason,
    applied: false,
    overlay,
    note: `${OVERLAY_NOTE} Proposta gravada — confirme na UI/API para activar.`,
  }
  saveTipOverlayProposal(proposal)
  return proposal
}

export function applyTipOverlay(opts: {
  confirm?: boolean
  overlay?: unknown
  id?: string
  reason?: string
}): TipOverlayProposal {
  if (opts.confirm !== true) {
    throw new Error(
      'Aplicação do overlay exige confirmação explícita (confirm:true).',
    )
  }
  const proposed = loadTipOverlayProposal()
  const overlay = opts.overlay
    ? normalizeTipOverlay(opts.overlay)
    : proposed && (opts.id === proposed.id || opts.id === 'latest' || !opts.id)
      ? proposed.overlay
      : null
  if (!overlay) {
    throw new Error('Proposta de overlay inexistente')
  }
  saveTipOverlay(overlay)
  const applied: TipOverlayProposal = {
    id: proposed?.id ?? `overlay-${Date.now()}`,
    ts: new Date().toISOString(),
    reason: opts.reason || 'manual',
    applied: true,
    overlay,
    note: 'Overlay activo confirmado. params*.json / regras Spike-Swing-Sustained não foram alterados.',
  }
  saveTipOverlayProposal(applied)
  return applied
}

export function logTipSkip(reason: string, extra: Record<string, unknown>): void {
  const entry = { ts: new Date().toISOString(), reason, ...extra }
  console.log('[tip skip]', reason, extra)
  appendTipSkip(entry)
}

export function tipAlreadyOpen(fixtureId: string, alertId: string): boolean {
  return loadTips().some(
    (t) => t.fixtureId === fixtureId && t.alertId === alertId,
  )
}

export function createTipFromAlert(args: {
  fixture: Fixture
  alert: FeedAlert
  odd: ResolvedOdd
}): Tip {
  const market = parseMarket(args.alert.market)
  const half = halfOfAlert(
    market,
    args.alert.min,
    args.alert.period,
    args.alert.cornerHalf,
  )
  const tip: Tip = {
    id: `tip-${args.fixture.id}-${args.alert.id}`,
    ts: args.alert.firedAt || new Date().toISOString(),
    league: args.odd.league || args.fixture.competition,
    home: args.fixture.team1,
    away: args.fixture.team2,
    market,
    half,
    minute: args.alert.min,
    period: args.alert.period,
    odd: args.odd.odd,
    line: args.odd.line,
    stake: 1,
    status: 'open',
    pnl: null,
    rule: args.alert.rule,
    scores: {
      home: args.alert.goalsTally?.home ?? args.fixture.scoreHome ?? 0,
      away: args.alert.goalsTally?.away ?? args.fixture.scoreAway ?? 0,
    },
    fixtureId: args.fixture.id,
    matchLabel: args.alert.matchLabel,
    alertId: args.alert.id,
    source: args.odd.source,
    sourceLabel: args.odd.sourceLabel,
    goalsTally: args.alert.goalsTally,
    cornersTally: args.alert.cornersTally,
    settledAt: null,
    longDeadline: null,
  }
  const tips = loadTips().filter((t) => t.id !== tip.id)
  tips.push(tip)
  saveTips(tips)
  return tip
}

export function tipNotificationCopy(tip: Tip): { title: string; body: string } {
  const label = ENTRY_LABELS[entryTypeOf(tip.market, tip.half)]
  const tallies =
    tip.goalsTally && tip.cornersTally
      ? formatTalliesLine(tip.goalsTally, tip.cornersTally)
      : null
  const title = [
    'Tip',
    label,
    `Odd ${formatOddPt(tip.odd)}`,
    tallies,
  ]
    .filter(Boolean)
    .join(' · ')
  const body = [
    tip.matchLabel,
    `${tip.minute}'`,
    tip.sourceLabel,
    tip.line !== null ? `linha ${String(tip.line).replace('.', ',')}` : null,
  ]
    .filter(Boolean)
    .join(' · ')
  return { title, body }
}

function eventAfterTip(
  event: GoalEvent,
  tip: Tip,
  deadlineMin: number,
  sameWindowOnly: boolean,
): boolean {
  if (event.period !== tip.period) {
    if (event.period < tip.period) return false
    if (sameWindowOnly) return false
  } else if (event.min <= tip.minute) {
    return false
  }
  if (event.min > deadlineMin) return false
  if (sameWindowOnly) {
    const eventHalf = cornerHalfOf(event.min, event.period)
    if (eventHalf !== tip.half) return false
  }
  return true
}

export function settleTipsForMatch(args: {
  fixture: Fixture
  events: GoalEvent[]
  points: { period: number; min: number }[]
  market: Market
  finished: boolean
  clockMin?: number
  clockPeriod?: number
}): Tip[] {
  const tips = loadTips()
  let changed = false
  const now = new Date().toISOString()
  const updated = tips.map((tip) => {
    if (tip.status !== 'open') return tip
    if (tip.fixtureId !== args.fixture.id) return tip
    if (parseMarket(tip.market) !== parseMarket(args.market)) return tip
    const horizon = horizonOptionsForHalf(tip.market === 'corners' ? tip.half : null)
    const deadline = longDeadlineMin(
      tip.minute,
      tip.period,
      args.points,
      horizon.deadlineCap,
    )
    const hit = args.events.some((event) =>
      eventAfterTip(event, tip, deadline, Boolean(horizon.sameWindowOnly)),
    )
    if (hit) {
      changed = true
      return {
        ...tip,
        status: 'won' as const,
        pnl: tipPnl(tip.odd, 'won'),
        settledAt: now,
        longDeadline: deadline,
      }
    }
    const clockPast =
      args.clockMin !== undefined &&
      args.clockPeriod !== undefined &&
      (args.clockPeriod > tip.period ||
        (args.clockPeriod === tip.period && args.clockMin > deadline))
    const periodOver =
      args.finished ||
      (args.clockPeriod !== undefined &&
        args.clockPeriod > tip.period &&
        periodEndMin(args.points, tip.period) <= deadline)
    if (clockPast || periodOver || args.finished) {
      changed = true
      return {
        ...tip,
        status: 'lost' as const,
        pnl: tipPnl(tip.odd, 'lost'),
        settledAt: now,
        longDeadline: deadline,
      }
    }
    if (tip.longDeadline !== deadline) {
      changed = true
      return { ...tip, longDeadline: deadline }
    }
    return tip
  })
  if (changed) saveTips(updated)
  return updated
}

export function tipsPayload() {
  const tips = loadTips()
  const open = tips.filter((t) => t.status === 'open').slice().reverse()
  const settled = tips
    .filter((t) => t.status !== 'open')
    .slice()
    .reverse()
  return {
    open,
    settled,
    roi: computeRoi(tips),
    leagues: computeLeagueFollowup(tips),
    quotes: loadRobobetQuotes().slice(-20).reverse(),
    overlay: overlayPayload(),
    horizonLongCap: HORIZON_LONG_CAP,
  }
}
