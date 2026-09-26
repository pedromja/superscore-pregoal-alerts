import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  goalHadPrealert,
  HORIZON_LONG_CAP,
  HORIZON_SHORT,
  horizonOptionsForMarket,
  outcomeForAlert,
} from '../src/lib/horizons.ts'
import {
  DEFINITIONS_LOCKED,
  LOCK_APPLY_ERROR_PT,
  LOCK_SAVE_ERROR_PT,
} from '../src/lib/lock.ts'
import { defaultsFor, parseMarket } from '../src/lib/market.ts'
import {
  evaluateAlerts,
  evaluateReplay,
  extractMarketEvents,
  RULE_SHORT,
} from '../src/lib/rules.ts'
import { withMatchTallies } from '../src/lib/tally.ts'
import type {
  AlertSettings,
  CornerHalf,
  FeedAlert,
  Market,
  MomentumPayload,
  RuleId,
} from '../src/lib/types.ts'
import {
  CORNER_HALVES,
  GOAL_HALVES,
  cornerHalfOf,
  goalHalfOf,
  inGoalsWindow,
  parseCornerHalf,
  parseCornerHalfOpt,
} from '../src/lib/windows.ts'
import { LEARN_AUTO_APPLY, LEARN_AUTO_MIN_OUTCOMES, LEARN_WINDOW, ROOT } from './config.ts'
import {
  enqueueAndFlushTelegramOutcomes,
  enqueueSettledTelegramOutcomes,
  scheduleTelegramOutcomeFlush,
  alertOutcomeNewlySettled,
} from './telegramOutcomes.ts'
import {
  listMatches,
  loadActiveMarket,
  loadAlerts,
  loadGoals,
  loadHistory,
  loadParams,
  loadProposal,
  resetLearnStore,
  saveAlerts,
  saveHistory,
  saveMatch,
  saveParams,
  saveProposal,
  upsertAlerts,
  upsertGoals,
  type ResetLearnMarket,
} from './store.ts'
import type {
  DualMetrics,
  GoalRecord,
  LearnSummary,
  LoggedAlert,
  ParamVersion,
  RuleMetrics,
  StoredMatch,
} from './types.ts'

const RULES: RuleId[] = ['primary', 'secondary', 'fallback']

export function resolveMarket(value?: unknown): Market {
  return parseMarket(value, loadActiveMarket())
}

export function currentSettings(
  market?: Market,
  half?: CornerHalf | null,
): AlertSettings {
  const m = market ?? loadActiveMarket()
  const h = parseCornerHalf(half)
  const defaults = defaultsFor(m, h)
  const stored = loadParams(m, h)
  const notify = {
    notificationsEnabled:
      stored?.notificationsEnabled ?? defaults.notificationsEnabled,
    notifyPrimary: stored?.notifyPrimary ?? defaults.notifyPrimary,
    notifySecondary: stored?.notifySecondary ?? defaults.notifySecondary,
    notifyFallback: stored?.notifyFallback ?? defaults.notifyFallback,
  }
  if (DEFINITIONS_LOCKED) {
    return {
      ...defaults,
      ...notify,
      market: m,
      cornerHalf: h,
      evaluationWindow:
        m === 'corners' ? defaults.evaluationWindow : LEARN_WINDOW,
    }
  }
  return {
    ...defaults,
    ...stored,
    ...notify,
    market: m,
    cornerHalf: h,
    evaluationWindow:
      m === 'corners'
        ? (stored?.evaluationWindow ?? defaults.evaluationWindow)
        : LEARN_WINDOW,
  }
}

export function snapshotOf(settings: AlertSettings): Partial<AlertSettings> {
  return {
    market: settings.market,
    cornerHalf: settings.cornerHalf,
    primaryKind: settings.primaryKind,
    secondaryKind: settings.secondaryKind,
    fallbackKind: settings.fallbackKind,
    spikeThreshold: settings.spikeThreshold,
    swingComboThreshold: settings.swingComboThreshold,
    swingSecondaryThreshold: settings.swingSecondaryThreshold,
    sustainedThreshold: settings.sustainedThreshold,
    sustainedComboMinutes: settings.sustainedComboMinutes,
    sustainedFallbackMinutes: settings.sustainedFallbackMinutes,
    fallbackSpikeThreshold: settings.fallbackSpikeThreshold,
    fallbackSustainedThreshold: settings.fallbackSustainedThreshold,
    sustainedSecondaryThreshold: settings.sustainedSecondaryThreshold,
    sustainedSecondaryMinutes: settings.sustainedSecondaryMinutes,
    evaluationWindow: settings.evaluationWindow,
  }
}

export function toLoggedAlert(
  alert: FeedAlert,
  settings: AlertSettings,
  sentPush = false,
): LoggedAlert {
  const market = parseMarket(alert.market ?? settings.market)
  const half = parseCornerHalf(
    alert.cornerHalf ??
      settings.cornerHalf ??
      (market === 'corners'
        ? cornerHalfOf(alert.min, alert.period)
        : goalHalfOf(alert.min, alert.period)),
  )
  return {
    id: `${alert.fixtureId}:${alert.id}`,
    fixtureId: alert.fixtureId,
    matchLabel: alert.matchLabel,
    minute: alert.min,
    period: alert.period,
    index: alert.index,
    side: alert.side,
    ruleId: alert.rule,
    market,
    cornerHalf: half,
    features: {
      v: alert.momentum,
      delta1: alert.delta1,
      sustained: alert.sustainedLength,
    },
    thresholdsSnapshot: snapshotOf(settings),
    ts: alert.firedAt,
    coincident: alert.coincident,
    hit: null,
    leadMin: null,
    hit5: null,
    hitLong: null,
    longDeadline: null,
    leadTime5: null,
    leadTimeLong: null,
    labeledAt: null,
    feedback: null,
    sentPush,
    telegramMessageId: undefined,
    telegramOutcomeSentAt: null,
    odds: alert.odds,
    ...(alert.overlay ? { overlay: alert.overlay } : {}),
  }
}

export function labelMatch(
  match: StoredMatch,
  window = LEARN_WINDOW,
  market?: Market,
  half?: CornerHalf | null,
  opts: { flushTelegramOutcomes?: boolean } = {},
): void {
  const m = market ?? loadActiveMarket()
  if (!parseCornerHalfOpt(half)) {
    for (const h of m === 'corners' ? CORNER_HALVES : GOAL_HALVES) {
      labelMatch(match, window, m, h, { flushTelegramOutcomes: false })
    }
    if (opts.flushTelegramOutcomes !== false) scheduleTelegramOutcomeFlush()
    return
  }
  const settings = currentSettings(m, half)
  const { points, alerts: fired } = evaluateAlerts(match.payload, {
    ...settings,
    evaluationWindow: settings.evaluationWindow || window,
  })
  const goals = extractMarketEvents(match.payload, points, m, settings.cornerHalf)
  const horizon = horizonOptionsForMarket(m, settings.cornerHalf)
  const firedLite = fired.map((a) => ({
    min: a.min,
    period: a.period,
    side: a.side,
    coincident: goals.some(
      (g) => g.period === a.period && g.min === a.min && g.index === a.index,
    ),
  }))

  const previous = loadAlerts(m, settings.cornerHalf)
  const prevById = new Map(previous.map((a) => [a.id, a]))
  const settled: LoggedAlert[] = []
  const alerts = previous.map((alert) => {
    if (alert.fixtureId !== match.fixture.id) return alert
    const out = outcomeForAlert(
      {
        min: alert.minute,
        period: alert.period,
        side: alert.side,
        coincident: alert.coincident,
      },
      goals,
      points,
      horizon,
    )
    const next: LoggedAlert = {
      ...alert,
      market: m,
      cornerHalf: settings.cornerHalf,
      hit: out.hit5,
      leadMin: out.leadTime5,
      hit5: out.hit5,
      hitLong: out.hitLong,
      longDeadline: out.longDeadline,
      leadTime5: out.leadTime5,
      leadTimeLong: out.leadTimeLong,
      labeledAt: new Date().toISOString(),
    }
    if (alertOutcomeNewlySettled(prevById.get(alert.id), next)) {
      settled.push(next)
    }
    return next
  })
  saveAlerts(alerts, m, settings.cornerHalf)
  enqueueSettledTelegramOutcomes(settled)
  if (opts.flushTelegramOutcomes !== false) scheduleTelegramOutcomeFlush()

  const records: GoalRecord[] = goals.map((goal) => {
    const short = goalHadPrealert(goal, firedLite, points, 'short', horizon)
    const long = goalHadPrealert(goal, firedLite, points, 'long', horizon)
    return {
      fixtureId: match.fixture.id,
      matchLabel: `${match.fixture.team1} vs ${match.fixture.team2}`,
      period: goal.period,
      min: goal.min,
      index: goal.index,
      side: goal.side,
      market: m,
      cornerHalf: settings.cornerHalf,
      hadPrealert: short.hit,
      leadMin: short.lead,
      hadPrealert5: short.hit,
      hadPrealertLong: long.hit,
      leadMin5: short.lead,
      leadMinLong: long.lead,
    }
  })
  upsertGoals(records, m, settings.cornerHalf)
}

function emptyMetrics(): RuleMetrics {
  return {
    precision: null,
    recall: null,
    alerts: 0,
    labeled: 0,
    hits: 0,
    goals: 0,
    goalsHit: 0,
    alertsPerMatch: 0,
    medianLead: null,
  }
}

function weightedHit(alert: LoggedAlert, field: 'hit5' | 'hitLong'): boolean | null {
  if (alert.feedback === 'up') return true
  if (alert.feedback === 'down') return false
  return alert[field] ?? alert.hit
}

function scoreNoteFor(settings: AlertSettings): string {
  const short = settings.evaluationWindow || HORIZON_SHORT
  const cap = settings.market === 'corners' ? 16 : 12
  return `Score = 0,4×precisão(≤${short} min) + 0,6×precisão(≤15 min ou fim da janela/parte), menos penalização se alertas/jogo > ${cap}. HIT exige lead ≥1 min (ideal 1–2). A aprendizagem só propõe; com definições locked aplicar exige desbloquear + confirmar.`
}

export function computeMetrics(
  settings: AlertSettings = currentSettings(),
): LearnSummary {
  const market = parseMarket(settings.market)
  const half = parseCornerHalf(settings.cornerHalf)
  const matches = listMatches()
  const alerts = loadAlerts(market, half).filter((a) => !a.coincident)
  const goals = loadGoals(market, half)
  const nMatches = Math.max(1, new Set(matches.map((m) => m.fixture.id)).size)
  const horizonShort = settings.evaluationWindow || HORIZON_SHORT

  function slice(rule: RuleId | undefined, field: 'hit5' | 'hitLong'): RuleMetrics {
    const subset = rule ? alerts.filter((a) => a.ruleId === rule) : alerts
    const labeled = subset.filter((a) => weightedHit(a, field) !== null)
    const hits = labeled.filter((a) => weightedHit(a, field) === true).length
    const goalsHit = goals.filter((g) =>
      field === 'hit5' ? g.hadPrealert5 ?? g.hadPrealert : g.hadPrealertLong,
    ).length
    const leads = labeled
      .map((a) => (field === 'hit5' ? a.leadTime5 ?? a.leadMin : a.leadTimeLong))
      .filter((n): n is number => n !== null && n > 0)
      .sort((a, b) => a - b)
    return {
      precision: labeled.length ? hits / labeled.length : null,
      recall: goals.length ? goalsHit / goals.length : null,
      alerts: subset.length,
      labeled: labeled.length,
      hits,
      goals: goals.length,
      goalsHit,
      alertsPerMatch: subset.length / nMatches,
      medianLead: leads.length
        ? leads[Math.floor((leads.length - 1) / 2)]
        : null,
    }
  }

  function dual(rule?: RuleId): DualMetrics {
    return { w5: slice(rule, 'hit5'), wLong: slice(rule, 'hitLong') }
  }

  const byRule = {
    primary: dual('primary'),
    secondary: dual('secondary'),
    fallback: dual('fallback'),
  }
  for (const rule of RULES) {
    byRule[rule] = replayRule(settings, rule)
  }

  const history = loadHistory(market, half)
  return {
    market,
    half,
    horizonShort,
    horizonLongCap: HORIZON_LONG_CAP,
    window: horizonShort,
    matches: matches.length,
    global: dual(),
    byRule,
    unlabeled: alerts.filter((a) => a.hit5 === null && a.hit === null && !a.feedback)
      .length,
    lastRecalcAt: history.at(-1)?.ts ?? null,
    scoreNote: scoreNoteFor(settings),
  }
}

function overCap(market: Market): number {
  return market === 'corners' ? 16 : 12
}

function scoreOf(m: DualMetrics, market: Market): number {
  const over = Math.max(0, m.wLong.alertsPerMatch - overCap(market))
  return 0.4 * (m.w5.precision ?? 0) + 0.6 * (m.wLong.precision ?? 0) - 0.02 * over
}

function replayRule(settings: AlertSettings, rule?: RuleId): DualMetrics {
  const scoped: AlertSettings = {
    ...settings,
    enablePrimary: rule ? rule === 'primary' : settings.enablePrimary,
    enableSecondary: rule ? rule === 'secondary' : settings.enableSecondary,
    enableFallback: rule ? rule === 'fallback' : settings.enableFallback,
  }
  return replayAll(scoped)
}

function replayAll(settings: AlertSettings): DualMetrics {
  const matches = listMatches()
  if (!matches.length) return { w5: emptyMetrics(), wLong: emptyMetrics() }
  const market = parseMarket(settings.market)
  const half = parseCornerHalf(settings.cornerHalf)
  const horizon = horizonOptionsForMarket(market, half)

  let alerts = 0
  let tp5 = 0
  let tpLong = 0
  let goals = 0
  let goalsHit5 = 0
  let goalsHitLong = 0
  const leads5: number[] = []
  const leadsLong: number[] = []

  for (const match of matches) {
    const { points, alerts: fired } = evaluateAlerts(match.payload, settings)
    const goalsEv = extractMarketEvents(match.payload, points, market, half)
    const usable = fired.filter(
      (a) => !goalsEv.some((g) => g.period === a.period && g.min === a.min),
    )
    alerts += usable.length
    goals += goalsEv.length
    for (const alert of usable) {
      const out = outcomeForAlert(alert, goalsEv, points, horizon)
      if (out.hit5) {
        tp5 += 1
        if (out.leadTime5) leads5.push(out.leadTime5)
      }
      if (out.hitLong) {
        tpLong += 1
        if (out.leadTimeLong) leadsLong.push(out.leadTimeLong)
      }
    }
    const lite = usable.map((a) => ({
      min: a.min,
      period: a.period,
      side: a.side,
      coincident: false,
    }))
    for (const goal of goalsEv) {
      const s = goalHadPrealert(goal, lite, points, 'short', horizon)
      const l = goalHadPrealert(goal, lite, points, 'long', horizon)
      if (s.hit) goalsHit5 += 1
      if (l.hit) goalsHitLong += 1
    }
  }

  leads5.sort((a, b) => a - b)
  leadsLong.sort((a, b) => a - b)
  const n = Math.max(1, matches.length)
  const pack = (
    tp: number,
    goalsHit: number,
    leads: number[],
  ): RuleMetrics => ({
    precision: alerts ? tp / alerts : null,
    recall: goals ? goalsHit / goals : null,
    alerts,
    labeled: alerts,
    hits: tp,
    goals,
    goalsHit,
    alertsPerMatch: alerts / n,
    medianLead: leads.length ? leads[Math.floor((leads.length - 1) / 2)] : null,
  })
  return {
    w5: pack(tp5, goalsHit5, leads5),
    wLong: pack(tpLong, goalsHitLong, leadsLong),
  }
}

function around(center: number, step: number, min: number, max: number): number[] {
  const raw = [center - 2 * step, center - step, center, center + step, center + 2 * step]
  return [...new Set(raw.map((n) => Math.min(max, Math.max(min, n))))]
}

function candidateSettings(base: AlertSettings): AlertSettings[] {
  const out: AlertSettings[] = []
  if (base.market === 'corners') {
    const spikes = around(base.spikeThreshold, 5, 50, 90)
    const swings = around(base.swingComboThreshold, 10, 30, 60)
    const sustT = around(base.sustainedThreshold, 5, 15, 40)
    const sustN = around(base.sustainedComboMinutes, 1, 2, 5)
    const sustSecT = around(base.sustainedSecondaryThreshold, 5, 15, 40)
    const sustSecN = around(base.sustainedSecondaryMinutes, 1, 2, 5)
    const fbSpike = around(base.fallbackSpikeThreshold, 5, 70, 95)
    const fbSustT = around(base.fallbackSustainedThreshold, 5, 20, 40)
    const fbSustN = around(base.sustainedFallbackMinutes, 1, 2, 5)
    const half = parseCornerHalf(base.cornerHalf)
    if (half === 'ft') {
      for (const spikeThreshold of spikes) {
        for (const swingComboThreshold of swings) {
          for (const sustainedThreshold of sustT) {
            for (const sustainedComboMinutes of sustN) {
              for (const sustainedSecondaryThreshold of sustSecT) {
                for (const fallbackSpikeThreshold of fbSpike) {
                  out.push({
                    ...base,
                    spikeThreshold,
                    swingComboThreshold,
                    sustainedThreshold,
                    sustainedComboMinutes,
                    sustainedSecondaryThreshold,
                    fallbackSpikeThreshold,
                  })
                }
              }
            }
          }
        }
      }
      return out
    }
    for (const spikeThreshold of spikes) {
      for (const swingComboThreshold of swings) {
        for (const sustainedThreshold of sustT) {
          for (const sustainedComboMinutes of sustN) {
            for (const sustainedSecondaryMinutes of sustSecN) {
              for (const fallbackSustainedMinutes of fbSustN) {
                out.push({
                  ...base,
                  spikeThreshold,
                  swingComboThreshold,
                  sustainedThreshold,
                  sustainedComboMinutes,
                  sustainedSecondaryMinutes,
                  sustainedFallbackMinutes: fallbackSustainedMinutes,
                  fallbackSustainedThreshold: fbSustT.includes(base.fallbackSustainedThreshold)
                    ? base.fallbackSustainedThreshold
                    : base.fallbackSustainedThreshold,
                })
              }
            }
          }
        }
      }
    }
    return out
  }

  const spikes = around(base.spikeThreshold, 5, 70, 90)
  const swings = around(base.swingComboThreshold, 10, 40, 70)
  const swing2 = around(base.swingSecondaryThreshold, 10, 40, 70)
  const sustT = around(base.sustainedThreshold, 5, 25, 40)
  const sustN = around(base.sustainedComboMinutes, 1, 2, 5)
  const sustF = around(base.sustainedFallbackMinutes, 1, 3, 5)
  for (const spikeThreshold of spikes) {
    for (const swingComboThreshold of swings) {
      for (const swingSecondaryThreshold of swing2) {
        for (const sustainedThreshold of sustT) {
          for (const sustainedComboMinutes of sustN) {
            for (const sustainedFallbackMinutes of sustF) {
              out.push({
                ...base,
                spikeThreshold,
                swingComboThreshold,
                swingSecondaryThreshold,
                sustainedThreshold,
                sustainedComboMinutes,
                sustainedFallbackMinutes,
                fallbackSustainedThreshold: sustainedThreshold,
              })
            }
          }
        }
      }
    }
  }
  return out
}

export function recalculate(
  reason = 'manual',
  market?: Market,
  half?: CornerHalf | null,
): ParamVersion {
  const m = market ?? loadActiveMarket()
  const h = parseCornerHalf(half)
  const base = currentSettings(m, h)
  const before = replayAll(base)
  let best = { settings: base, metrics: before, score: scoreOf(before, m) }

  for (const settings of candidateSettings(base)) {
    const metrics = replayAll(settings)
    const score = scoreOf(metrics, m)
    if (score > best.score) best = { settings, metrics, score }
  }

  const precisionGain =
    (best.metrics.wLong.precision ?? 0) - (before.wLong.precision ?? 0)
  const recallDrop = (before.wLong.recall ?? 0) - (best.metrics.wLong.recall ?? 0)
  const autoEligible = precisionGain >= 0.01 && recallDrop <= 0.03
  const changed =
    JSON.stringify(snapshotOf(best.settings)) !== JSON.stringify(snapshotOf(base))

  const proposal: ParamVersion = {
    id: `prop-${Date.now()}`,
    ts: new Date().toISOString(),
    reason,
    applied: false,
    settings: best.settings,
    before,
    after: best.metrics,
    score: best.score,
    autoEligible: autoEligible && changed,
    note: !changed
      ? 'Os defaults atuais já maximizam o score neste conjunto. Regras base inalteradas.'
      : autoEligible
        ? 'Precisão sobe ≥1pp sem recall cair >3pp — proposta conservadora. Confirme na UI para aplicar; nada é escrito em silêncio.'
        : 'Proposta fora da guarda conservadora: confirme na UI antes de aplicar. As regras base não mudam sem essa confirmação.',
  }
  saveProposal(proposal, m, base.cornerHalf)
  enqueueAndFlushTelegramOutcomes(loadAlerts(m, base.cornerHalf))

  if (LEARN_AUTO_APPLY && proposal.autoEligible) {
    const labeled = loadAlerts(m, base.cornerHalf).filter(
      (a) => a.hit !== null || a.feedback,
    ).length
    if (labeled >= LEARN_AUTO_MIN_OUTCOMES) {
      proposal.note = `${proposal.note} LEARN_AUTO_APPLY=1 está definido, mas o auto-aplicar continua desligado — use o botão / API de confirmação.`
      saveProposal(proposal, m, base.cornerHalf)
    }
  }
  return proposal
}

export function applyProposal(
  id: string,
  reason = 'manual',
  market?: Market,
  half?: CornerHalf | null,
  opts: { confirm?: boolean; unlock?: boolean } = {},
): ParamVersion {
  if (opts.confirm !== true) {
    throw new Error(
      'Aplicação exige confirmação explícita (confirm:true). As regras base não mudam em silêncio.',
    )
  }
  if (reason === 'auto') {
    throw new Error('Auto-aplicar está desligado. Confirme a proposta na UI.')
  }
  if (DEFINITIONS_LOCKED && opts.unlock !== true) {
    throw new Error(LOCK_APPLY_ERROR_PT)
  }
  const m = market ?? loadActiveMarket()
  const h = parseCornerHalf(half)
  const proposal = loadProposal(m, h)
  if (!proposal || (id !== proposal.id && id !== 'latest')) {
    throw new Error('Proposta inexistente')
  }
  const prev = currentSettings(m, h)
  saveParams({ ...proposal.settings, market: m, cornerHalf: h }, m, h)
  const applied: ParamVersion = {
    ...proposal,
    applied: true,
    reason,
    ts: new Date().toISOString(),
    note: `Aplicado (${reason}). Antes spike ${prev.spikeThreshold} → ${proposal.settings.spikeThreshold}.`,
  }
  saveHistory([...loadHistory(m, h), applied], m, h)
  saveProposal(applied, m, h)
  return applied
}

export function putParams(
  incoming: Partial<AlertSettings> & Pick<AlertSettings, 'market'>,
  opts: { confirm?: boolean; unlock?: boolean } = {},
): AlertSettings {
  if (opts.confirm !== true) {
    throw new Error(
      'Gravação exige confirmação explícita (confirm:true). As regras base não mudam em silêncio.',
    )
  }
  if (DEFINITIONS_LOCKED && opts.unlock !== true) {
    throw new Error(LOCK_SAVE_ERROR_PT)
  }
  const m = parseMarket(incoming.market)
  const h = parseCornerHalf(incoming.cornerHalf)
  const next: AlertSettings = {
    ...defaultsFor(m, h),
    ...incoming,
    market: m,
    cornerHalf: h,
  }
  saveParams(next, m, h)
  return currentSettings(m, h)
}

export function setFeedback(
  alertId: string,
  feedback: 'up' | 'down' | null,
  market?: Market,
  half?: CornerHalf | null,
): LoggedAlert {
  const m = market ?? loadActiveMarket()
  if (!parseCornerHalfOpt(half)) {
    try {
      return setFeedback(alertId, feedback, m, 'ht')
    } catch {
      return setFeedback(alertId, feedback, m, 'ft')
    }
  }
  const h = parseCornerHalf(half)
  const alerts = loadAlerts(m, h)
  const idx = alerts.findIndex((a) => a.id === alertId)
  if (idx < 0) throw new Error('Alerta não encontrado')
  alerts[idx] = { ...alerts[idx], feedback }
  saveAlerts(alerts, m, h)
  return alerts[idx]
}

function usableCornerAlert(alert: FeedAlert): boolean {
  return cornerHalfOf(alert.min, alert.period) !== null
}

function usableGoalAlert(alert: FeedAlert): boolean {
  return inGoalsWindow(alert.min, alert.period)
}

export function ingestFeedAlerts(
  alerts: FeedAlert[],
  settings: AlertSettings,
  sentPush = false,
  market?: Market,
  half?: CornerHalf | null,
): LoggedAlert[] {
  const m = parseMarket(market ?? settings.market ?? alerts[0]?.market)
  const clockHalf = m === 'corners' ? cornerHalfOf : goalHalfOf
  const forced = parseCornerHalfOpt(half)
  const halves = forced ? [forced] : m === 'corners' ? CORNER_HALVES : GOAL_HALVES
  const stored: LoggedAlert[] = []
  for (const h of halves) {
    const slice = alerts.filter((a) => {
      if (a.coincident) return false
      if (m === 'corners' && !usableCornerAlert(a)) return false
      if (m === 'goals' && !usableGoalAlert(a)) return false
      const found = a.cornerHalf ?? clockHalf(a.min, a.period)
      return found === h
    })
    if (!slice.length) continue
    const halfSettings =
      settings.cornerHalf === h ? settings : currentSettings(m, h)
    const logged = slice.map((a) =>
      toLoggedAlert(
        { ...a, market: m, cornerHalf: h },
        halfSettings,
        sentPush,
      ),
    )
    const prev = loadAlerts(m, h)
    const prevById = new Map(prev.map((a) => [a.id, a]))
    // upsert may mutate nothing (no-op merge skips the write); pass the list
    // we already parsed. prevById keeps the pre-merge records for outcomes.
    const next = upsertAlerts(logged, m, h, [...prev])
    stored.push(...next)
    const newly = next.filter((alert) =>
      alertOutcomeNewlySettled(prevById.get(alert.id), alert),
    )
    enqueueSettledTelegramOutcomes(newly)
  }
  return stored
}

export function seedDemos(
  market?: Market,
  half?: CornerHalf | null,
): { matches: number; alerts: number } {
  const m = market ?? loadActiveMarket()
  if (!parseCornerHalfOpt(half)) {
    const ht = seedDemos(m, 'ht')
    const ft = seedDemos(m, 'ft')
    return { matches: ht.matches, alerts: ht.alerts + ft.alerts }
  }
  const settings = currentSettings(m, half)
  const demos = [
    {
      id: 'demo-celtic-ferenc',
      team1: 'Celtic',
      team2: 'Ferencváros',
      file: 'public/demo/celtic-ferenc-momentum.json',
      competition: 'Amostra offline',
    },
    {
      id: '34OXUvbRzi05vbQ8FOZsz',
      team1: 'Drava Ptuj',
      team2: 'NK Bistrica',
      file: 'public/demo/drava-bistrica-momentum.json',
      competition: 'Taça',
    },
  ]
  let alerts = 0
  for (const demo of demos) {
    const payload = JSON.parse(
      readFileSync(join(ROOT, demo.file), 'utf8'),
    ) as MomentumPayload
    const fixture = {
      id: demo.id,
      team1: demo.team1,
      team2: demo.team2,
      team1Id: '',
      team2Id: '',
      competition: demo.competition,
      category: 'demo',
      status: 100,
      state: 2,
      dateSeconds: 0,
      liveElapsedSeconds: null,
      scoreHome: null,
      scoreAway: null,
      scoreIsFt: true,
    }
    const match: StoredMatch = {
      fixture,
      payload,
      finished: true,
      updatedAt: new Date().toISOString(),
    }
    saveMatch(match)
    const replay = evaluateReplay(payload, settings)
    const feed: FeedAlert[] = replay.alerts
      .filter((a) =>
        m === 'corners' ? usableCornerAlert(a) : usableGoalAlert(a),
      )
      .map((a) =>
        withMatchTallies(
          {
            ...a,
            fixtureId: demo.id,
            matchLabel: `${demo.team1} vs ${demo.team2}`,
            firedAt: new Date().toISOString(),
            coincident: replay.coincidentAlerts.some((c) => c.id === a.id),
            market: m,
            cornerHalf: settings.cornerHalf,
          },
          payload,
        ),
      )
    ingestFeedAlerts(feed, settings, false, m, settings.cornerHalf)
    labelMatch(match, settings.evaluationWindow, m, settings.cornerHalf)
    alerts += feed.filter((a) => !a.coincident).length
  }
  return { matches: demos.length, alerts }
}

export function parseResetMarket(value: unknown): ResetLearnMarket {
  if (value === undefined || value === null || value === '') return 'all'
  if (value === 'goals' || value === 'corners' || value === 'all') return value
  throw new Error("market deve ser 'goals' | 'corners' | 'all'")
}

export function resetLearnStats(opts: {
  confirm?: unknown
  market?: unknown
}): ReturnType<typeof resetLearnStore> {
  if (opts.confirm !== true) {
    throw new Error(
      'Reset exige confirmação explícita (confirm:true). Não apaga VAPID, subscrições, overlay nem sent-keys.',
    )
  }
  return resetLearnStore(parseResetMarket(opts.market))
}

export { RULE_SHORT }
