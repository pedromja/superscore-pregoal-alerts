import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  goalHadPrealert,
  HORIZON_LONG_CAP,
  HORIZON_SHORT,
  outcomeForAlert,
} from '../src/lib/horizons.ts'
import { defaultsFor, parseMarket } from '../src/lib/market.ts'
import {
  evaluateAlerts,
  evaluateReplay,
  extractMarketEvents,
  RULE_SHORT,
} from '../src/lib/rules.ts'
import type {
  AlertSettings,
  FeedAlert,
  Market,
  MomentumPayload,
  RuleId,
} from '../src/lib/types.ts'
import { LEARN_AUTO_MIN_OUTCOMES, LEARN_WINDOW, ROOT } from './config.ts'
import {
  listMatches,
  loadActiveMarket,
  loadAlerts,
  loadGoals,
  loadHistory,
  loadParams,
  loadProposal,
  saveAlerts,
  saveHistory,
  saveMatch,
  saveParams,
  saveProposal,
  upsertAlerts,
  upsertGoals,
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

export function currentSettings(market?: Market): AlertSettings {
  const m = market ?? loadActiveMarket()
  return {
    ...defaultsFor(m),
    ...loadParams(m),
    market: m,
    evaluationWindow: LEARN_WINDOW,
  }
}

export function snapshotOf(settings: AlertSettings): Partial<AlertSettings> {
  return {
    market: settings.market,
    spikeThreshold: settings.spikeThreshold,
    swingComboThreshold: settings.swingComboThreshold,
    swingSecondaryThreshold: settings.swingSecondaryThreshold,
    sustainedThreshold: settings.sustainedThreshold,
    sustainedComboMinutes: settings.sustainedComboMinutes,
    sustainedFallbackMinutes: settings.sustainedFallbackMinutes,
    fallbackSpikeThreshold: settings.fallbackSpikeThreshold,
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
  }
}

export function labelMatch(
  match: StoredMatch,
  window = LEARN_WINDOW,
  market?: Market,
): void {
  const m = market ?? loadActiveMarket()
  const settings = currentSettings(m)
  const { points, alerts: fired } = evaluateAlerts(match.payload, {
    ...settings,
    evaluationWindow: window,
  })
  const goals = extractMarketEvents(match.payload, points, m)
  const firedLite = fired.map((a) => ({
    min: a.min,
    period: a.period,
    side: a.side,
    coincident: goals.some(
      (g) => g.period === a.period && g.min === a.min && g.index === a.index,
    ),
  }))

  const alerts = loadAlerts(m).map((alert) => {
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
    )
    return {
      ...alert,
      market: m,
      hit: out.hit5,
      leadMin: out.leadTime5,
      hit5: out.hit5,
      hitLong: out.hitLong,
      longDeadline: out.longDeadline,
      leadTime5: out.leadTime5,
      leadTimeLong: out.leadTimeLong,
      labeledAt: new Date().toISOString(),
    }
  })
  saveAlerts(alerts, m)

  const records: GoalRecord[] = goals.map((goal) => {
    const short = goalHadPrealert(goal, firedLite, points, 'short')
    const long = goalHadPrealert(goal, firedLite, points, 'long')
    return {
      fixtureId: match.fixture.id,
      matchLabel: `${match.fixture.team1} vs ${match.fixture.team2}`,
      period: goal.period,
      min: goal.min,
      index: goal.index,
      side: goal.side,
      market: m,
      hadPrealert: short.hit,
      leadMin: short.lead,
      hadPrealert5: short.hit,
      hadPrealertLong: long.hit,
      leadMin5: short.lead,
      leadMinLong: long.lead,
    }
  })
  upsertGoals(records, m)
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

const SCORE_NOTE =
  'Score = 0,4×precisão(≤5 min) + 0,6×precisão(≤15 min ou fim da parte), menos penalização se alertas/jogo > 12 (cantos > 16). A guarda automática olha para o horizonte longo.'

export function computeMetrics(
  settings: AlertSettings = currentSettings(),
): LearnSummary {
  const market = parseMarket(settings.market)
  const matches = listMatches()
  const alerts = loadAlerts(market).filter((a) => !a.coincident)
  const goals = loadGoals(market)
  const nMatches = Math.max(1, new Set(matches.map((m) => m.fixture.id)).size)

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
    const replayed = replayRule(settings, rule)
    byRule[rule] = replayed
  }

  const history = loadHistory(market)
  return {
    horizonShort: HORIZON_SHORT,
    horizonLongCap: HORIZON_LONG_CAP,
    window: HORIZON_SHORT,
    matches: matches.length,
    global: dual(),
    byRule,
    unlabeled: alerts.filter((a) => a.hit5 === null && a.hit === null && !a.feedback)
      .length,
    lastRecalcAt: history.at(-1)?.ts ?? null,
    scoreNote: SCORE_NOTE,
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
    const goalsEv = extractMarketEvents(match.payload, points, market)
    const usable = fired.filter(
      (a) => !goalsEv.some((g) => g.period === a.period && g.min === a.min),
    )
    alerts += usable.length
    goals += goalsEv.length
    for (const alert of usable) {
      const out = outcomeForAlert(alert, goalsEv, points)
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
      const s = goalHadPrealert(goal, lite, points, 'short')
      const l = goalHadPrealert(goal, lite, points, 'long')
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
    const spikes = around(base.spikeThreshold, 5, 50, 75)
    const swings = around(base.swingComboThreshold, 10, 30, 60)
    const fbSpike = around(base.fallbackSpikeThreshold, 5, 60, 80)
    const sustT = around(base.sustainedThreshold, 5, 15, 35)
    const sustN = around(base.sustainedComboMinutes, 1, 2, 5)
    const sustSecN = around(base.sustainedSecondaryMinutes, 1, 3, 6)
    for (const spikeThreshold of spikes) {
      for (const swingComboThreshold of swings) {
        for (const fallbackSpikeThreshold of fbSpike) {
          for (const sustainedThreshold of sustT) {
            for (const sustainedComboMinutes of sustN) {
              for (const sustainedSecondaryMinutes of sustSecN) {
                out.push({
                  ...base,
                  spikeThreshold,
                  swingComboThreshold,
                  fallbackSpikeThreshold,
                  sustainedThreshold,
                  sustainedComboMinutes,
                  sustainedSecondaryMinutes,
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
              })
            }
          }
        }
      }
    }
  }
  return out
}

export function recalculate(reason = 'manual', market?: Market): ParamVersion {
  const m = market ?? loadActiveMarket()
  const base = currentSettings(m)
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
      ? 'Os defaults atuais já maximizam o score neste conjunto.'
      : autoEligible
        ? 'Precisão sobe ≥1pp sem recall cair >3pp — pode aplicar-se automaticamente.'
        : 'Proposta fora da guarda conservadora: confirme na UI antes de aplicar.',
  }
  saveProposal(proposal, m)

  const labeled = loadAlerts(m).filter((a) => a.hit !== null || a.feedback).length
  if (
    proposal.autoEligible &&
    labeled >= LEARN_AUTO_MIN_OUTCOMES &&
    reason !== 'manual' &&
    reason !== 'seed-demos'
  ) {
    return applyProposal(proposal.id, 'auto', m)
  }
  return proposal
}

export function applyProposal(
  id: string,
  reason = 'manual',
  market?: Market,
): ParamVersion {
  const m = market ?? loadActiveMarket()
  const proposal = loadProposal(m)
  if (!proposal || (id !== proposal.id && id !== 'latest')) {
    throw new Error('Proposta inexistente')
  }
  const prev = currentSettings(m)
  saveParams({ ...proposal.settings, market: m }, m)
  const applied: ParamVersion = {
    ...proposal,
    applied: true,
    reason,
    ts: new Date().toISOString(),
    note: `Aplicado (${reason}). Antes spike ${prev.spikeThreshold} → ${proposal.settings.spikeThreshold}.`,
  }
  saveHistory([...loadHistory(m), applied], m)
  saveProposal(applied, m)
  return applied
}

export function setFeedback(
  alertId: string,
  feedback: 'up' | 'down' | null,
  market?: Market,
): LoggedAlert {
  const m = market ?? loadActiveMarket()
  const alerts = loadAlerts(m)
  const idx = alerts.findIndex((a) => a.id === alertId)
  if (idx < 0) throw new Error('Alerta não encontrado')
  alerts[idx] = { ...alerts[idx], feedback }
  saveAlerts(alerts, m)
  return alerts[idx]
}

export function ingestFeedAlerts(
  alerts: FeedAlert[],
  settings: AlertSettings,
  sentPush = false,
  market?: Market,
): LoggedAlert[] {
  const m = parseMarket(market ?? settings.market ?? alerts[0]?.market)
  const logged = alerts
    .filter((a) => !a.coincident)
    .map((a) => toLoggedAlert({ ...a, market: m }, settings, sentPush))
  return upsertAlerts(logged, m)
}

export function seedDemos(market?: Market): { matches: number; alerts: number } {
  const m = market ?? loadActiveMarket()
  const settings = currentSettings(m)
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
    const feed: FeedAlert[] = replay.alerts.map((a) => ({
      ...a,
      fixtureId: demo.id,
      matchLabel: `${demo.team1} vs ${demo.team2}`,
      firedAt: new Date().toISOString(),
      coincident: replay.coincidentAlerts.some((c) => c.id === a.id),
      market: m,
    }))
    ingestFeedAlerts(feed, settings, false, m)
    labelMatch(match, LEARN_WINDOW, m)
    alerts += feed.filter((a) => !a.coincident).length
  }
  return { matches: demos.length, alerts }
}

export { RULE_SHORT }
