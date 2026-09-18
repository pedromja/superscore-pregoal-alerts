import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_SETTINGS,
  evaluateReplay,
  RULE_SHORT,
} from '../src/lib/rules.ts'
import type {
  AlertSettings,
  FeedAlert,
  MomentumPayload,
  RuleId,
} from '../src/lib/types.ts'
import { LEARN_AUTO_MIN_OUTCOMES, LEARN_WINDOW, ROOT } from './config.ts'
import {
  listMatches,
  loadAlerts,
  loadGoals,
  loadHistory,
  loadParams,
  loadProposal,
  saveAlerts,
  saveGoals,
  saveHistory,
  saveMatch,
  saveParams,
  saveProposal,
  upsertAlerts,
  upsertGoals,
} from './store.ts'
import type {
  GoalRecord,
  LearnSummary,
  LoggedAlert,
  ParamVersion,
  RuleMetrics,
  StoredMatch,
} from './types.ts'

const RULES: RuleId[] = ['primary', 'secondary', 'fallback']

export function currentSettings(): AlertSettings {
  return { ...DEFAULT_SETTINGS, ...loadParams(), evaluationWindow: LEARN_WINDOW }
}

export function snapshotOf(settings: AlertSettings): Partial<AlertSettings> {
  return {
    spikeThreshold: settings.spikeThreshold,
    swingComboThreshold: settings.swingComboThreshold,
    swingSecondaryThreshold: settings.swingSecondaryThreshold,
    sustainedThreshold: settings.sustainedThreshold,
    sustainedComboMinutes: settings.sustainedComboMinutes,
    sustainedFallbackMinutes: settings.sustainedFallbackMinutes,
    evaluationWindow: settings.evaluationWindow,
  }
}

export function toLoggedAlert(
  alert: FeedAlert,
  settings: AlertSettings,
  sentPush = false,
): LoggedAlert {
  return {
    id: `${alert.fixtureId}:${alert.id}`,
    fixtureId: alert.fixtureId,
    matchLabel: alert.matchLabel,
    minute: alert.min,
    period: alert.period,
    index: alert.index,
    side: alert.side,
    ruleId: alert.rule,
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
    labeledAt: null,
    feedback: null,
    sentPush,
  }
}

export function labelMatch(match: StoredMatch, window = LEARN_WINDOW): void {
  const settings = currentSettings()
  const replay = evaluateReplay(match.payload, {
    ...settings,
    evaluationWindow: window,
  })
  const alerts = loadAlerts().map((alert) => {
    if (alert.fixtureId !== match.fixture.id) return alert
    if (alert.coincident) {
      return {
        ...alert,
        hit: false,
        leadMin: 0,
        labeledAt: alert.labeledAt ?? new Date().toISOString(),
      }
    }
    const goal = replay.goals.find(
      (g) =>
        g.side === alert.side &&
        g.index > alert.index &&
        g.index - alert.index <= window,
    )
    return {
      ...alert,
      hit: Boolean(goal),
      leadMin: goal ? goal.index - alert.index : null,
      labeledAt: new Date().toISOString(),
    }
  })
  saveAlerts(alerts)

  const goals: GoalRecord[] = replay.perGoal.map((row) => ({
    fixtureId: match.fixture.id,
    matchLabel: `${match.fixture.team1} vs ${match.fixture.team2}`,
    period: row.goal.period,
    min: row.goal.min,
    index: row.goal.index,
    side: row.goal.side,
    hadPrealert: row.hit,
    leadMin: row.bestLead,
  }))
  upsertGoals(goals)
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

function weightedHit(alert: LoggedAlert): boolean | null {
  if (alert.feedback === 'up') return true
  if (alert.feedback === 'down') return false
  return alert.hit
}

export function computeMetrics(
  settings: AlertSettings = currentSettings(),
): LearnSummary {
  const matches = listMatches()
  const alerts = loadAlerts().filter((a) => !a.coincident)
  const goals = loadGoals()
  const nMatches = Math.max(1, new Set(matches.map((m) => m.fixture.id)).size)

  function forRule(rule?: RuleId): RuleMetrics {
    const subset = rule ? alerts.filter((a) => a.ruleId === rule) : alerts
    const labeled = subset.filter((a) => weightedHit(a) !== null)
    const hits = labeled.filter((a) => weightedHit(a) === true).length
    const ruleGoals = goals
    const goalsHit = goals.filter((g) => g.hadPrealert).length
    const leads = labeled
      .map((a) => a.leadMin)
      .filter((n): n is number => n !== null && n > 0)
      .sort((a, b) => a - b)
    return {
      precision: labeled.length ? hits / labeled.length : null,
      recall: ruleGoals.length ? goalsHit / ruleGoals.length : null,
      alerts: subset.length,
      labeled: labeled.length,
      hits,
      goals: ruleGoals.length,
      goalsHit,
      alertsPerMatch: subset.length / nMatches,
      medianLead: leads.length
        ? leads[Math.floor((leads.length - 1) / 2)]
        : null,
    }
  }

  const byRule = {
    primary: forRule('primary'),
    secondary: forRule('secondary'),
    fallback: forRule('fallback'),
  }
  for (const rule of RULES) {
    const subsetGoals = matches.flatMap((m) => {
      const replay = evaluateReplay(m.payload, {
        ...settings,
        enablePrimary: rule === 'primary',
        enableSecondary: rule === 'secondary',
        enableFallback: rule === 'fallback',
      })
      return replay.perGoal
    })
    const hit = subsetGoals.filter((g) => g.hit).length
    byRule[rule].goals = subsetGoals.length
    byRule[rule].goalsHit = hit
    byRule[rule].recall = subsetGoals.length ? hit / subsetGoals.length : null
  }

  const history = loadHistory()
  return {
    window: settings.evaluationWindow,
    matches: matches.length,
    global: forRule(),
    byRule,
    unlabeled: alerts.filter((a) => a.hit === null && !a.feedback).length,
    lastRecalcAt: history.at(-1)?.ts ?? null,
  }
}

function scoreOf(m: RuleMetrics): number {
  const precision = m.precision ?? 0
  const recall = m.recall ?? 0
  const over = Math.max(0, m.alertsPerMatch - 12)
  return 0.6 * precision + 0.4 * recall - 0.02 * over
}

function replayAll(settings: AlertSettings): RuleMetrics {
  const matches = listMatches()
  if (!matches.length) return emptyMetrics()
    let alerts = 0
    let tp = 0
    let goals = 0
    let goalsHit = 0
    const leads: number[] = []
    for (const match of matches) {
      const replay = evaluateReplay(match.payload, settings)
      const usable = replay.alerts.filter(
        (a) => !replay.coincidentAlerts.some((c) => c.id === a.id),
      )
      const hitIds = new Set(
        replay.perGoal.flatMap((row) => row.preAlerts.map((a) => a.id)),
      )
      alerts += usable.length
      tp += usable.filter((a) => hitIds.has(a.id)).length
      goals += replay.goals.length
      goalsHit += replay.goalsHit
      for (const row of replay.perGoal) {
        if (row.bestLead) leads.push(row.bestLead)
      }
    }
    leads.sort((a, b) => a - b)
    const n = Math.max(1, matches.length)
    return {
      precision: alerts ? tp / alerts : null,
      recall: goals ? goalsHit / goals : null,
      alerts,
      labeled: alerts,
      hits: tp,
      goals,
      goalsHit,
      alertsPerMatch: alerts / n,
      medianLead: leads.length ? leads[Math.floor((leads.length - 1) / 2)] : null,
    }
  }

function around(center: number, step: number, min: number, max: number): number[] {
  const raw = [center - 2 * step, center - step, center, center + step, center + 2 * step]
  return [...new Set(raw.map((n) => Math.min(max, Math.max(min, n))))]
}

export function recalculate(reason = 'manual'): ParamVersion {
  const base = currentSettings()
  const before = replayAll(base)
  let best = { settings: base, metrics: before, score: scoreOf(before) }

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
              const settings: AlertSettings = {
                ...base,
                spikeThreshold,
                swingComboThreshold,
                swingSecondaryThreshold,
                sustainedThreshold,
                sustainedComboMinutes,
                sustainedFallbackMinutes,
              }
              const metrics = replayAll(settings)
              const score = scoreOf(metrics)
              if (score > best.score) best = { settings, metrics, score }
            }
          }
        }
      }
    }
  }

  const precisionGain =
    (best.metrics.precision ?? 0) - (before.precision ?? 0)
  const recallDrop = (before.recall ?? 0) - (best.metrics.recall ?? 0)
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
  saveProposal(proposal)

  const labeled = loadAlerts().filter((a) => a.hit !== null || a.feedback).length
  if (proposal.autoEligible && labeled >= LEARN_AUTO_MIN_OUTCOMES && reason !== 'manual') {
    return applyProposal(proposal.id, 'auto')
  }
  return proposal
}

export function applyProposal(id: string, reason = 'manual'): ParamVersion {
  const proposal = loadProposal()
  if (!proposal || (id !== proposal.id && id !== 'latest')) {
    throw new Error('Proposta inexistente')
  }
  const prev = currentSettings()
  saveParams(proposal.settings)
  const applied: ParamVersion = {
    ...proposal,
    applied: true,
    reason,
    ts: new Date().toISOString(),
    note: `Aplicado (${reason}). Antes spike ${prev.spikeThreshold} → ${proposal.settings.spikeThreshold}.`,
  }
  saveHistory([...loadHistory(), applied])
  saveProposal(applied)
  return applied
}

export function setFeedback(
  alertId: string,
  feedback: 'up' | 'down' | null,
): LoggedAlert {
  const alerts = loadAlerts()
  const idx = alerts.findIndex((a) => a.id === alertId)
  if (idx < 0) throw new Error('Alerta não encontrado')
  alerts[idx] = { ...alerts[idx], feedback }
  saveAlerts(alerts)
  return alerts[idx]
}

export function ingestFeedAlerts(
  alerts: FeedAlert[],
  settings: AlertSettings,
  sentPush = false,
): LoggedAlert[] {
  const logged = alerts
    .filter((a) => !a.coincident)
    .map((a) => toLoggedAlert(a, settings, sentPush))
  return upsertAlerts(logged)
}

export function seedDemos(): { matches: number; alerts: number } {
  const settings = currentSettings()
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
    }))
    ingestFeedAlerts(feed, settings, false)
    labelMatch(match)
    alerts += feed.filter((a) => !a.coincident).length
  }
  return { matches: demos.length, alerts }
}

export { RULE_SHORT }
