/**
 * Offline backtest for Goals HT/FT and Corners HT/FT.
 * Hard filters: lead >= 1, no stoppage (P1>45 / P2>90).
 * Score prefers lead in [1, 2] minutes.
 *
 * Usage: npx tsx scripts/backtest-lead.ts
 */
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  isPreferredLead,
  isUsableLead,
  MIN_LEAD_MIN,
  PREFERRED_LEAD_MAX,
  horizonOptionsForMarket,
  outcomeForAlert,
} from '../src/lib/horizons.ts'
import { defaultsFor, parseMarket } from '../src/lib/market.ts'
import { evaluateAlerts, extractMarketEvents } from '../src/lib/rules.ts'
import type {
  AlertSettings,
  CornerHalf,
  Market,
  MomentumPayload,
  RuleKind,
} from '../src/lib/types.ts'
import { CORNER_WINDOWS, GOAL_WINDOWS, isStoppageClock } from '../src/lib/windows.ts'

const ROOT = join(import.meta.dirname, '..')
const MATCH_DIR = join(ROOT, 'backtest-data', 'matches')
const OUT_DIR = join(ROOT, 'backtest-data')

type Dump = {
  fixture: { id: string; team1: string; team2: string; competition: string }
  payload: MomentumPayload
  date?: string
  region?: string
}

type LeadHist = Record<string, number>

type BucketMetrics = {
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
}

type Candidate = {
  settings: AlertSettings
  metrics: BucketMetrics
  score: number
}

function median(xs: number[]): number | null {
  if (!xs.length) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor((s.length - 1) / 2)]
}

function uniq(xs: number[]): number[] {
  return [...new Set(xs)]
}

function around(center: number, step: number, min: number, max: number): number[] {
  return uniq(
    [center - 2 * step, center - step, center, center + step, center + 2 * step].map(
      (n) => Math.min(max, Math.max(min, n)),
    ),
  )
}

function loadDumps(): Dump[] {
  const files = readdirSync(MATCH_DIR).filter((n) => n.endsWith('.json'))
  const out: Dump[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(MATCH_DIR, file), 'utf8')) as Dump
      const tl = raw.payload?.timeline?.length ?? 0
      if (tl < 80) continue
      out.push(raw)
    } catch {
      /* skip */
    }
  }
  return out
}

function scoreOf(m: BucketMetrics): number {
  const precP = m.precisionPreferred ?? 0
  const prec = m.precision ?? 0
  const rec = m.recall ?? 0
  const over = Math.max(0, m.alertsPerMatch - 8)
  const under = m.alertsPerMatch < 0.15 ? 0.05 : 0
  const medBonus =
    m.medianLead !== null &&
    m.medianLead >= MIN_LEAD_MIN &&
    m.medianLead <= PREFERRED_LEAD_MAX
      ? 0.04
      : 0
  return 0.42 * precP + 0.28 * prec + 0.26 * rec - 0.025 * over - under + medBonus
}

function evaluateBucket(
  dumps: Dump[],
  settings: AlertSettings,
): BucketMetrics {
  const market = parseMarket(settings.market)
  const half = (settings.cornerHalf ?? 'ht') as CornerHalf
  const horizon = horizonOptionsForMarket(market, half)
  let alerts = 0
  let hits = 0
  let preferredHits = 0
  let coincident = 0
  let events = 0
  let eventsHit = 0
  const leads: number[] = []
  const leadHist: LeadHist = {}

  for (const dump of dumps) {
    const { points, alerts: fired } = evaluateAlerts(dump.payload, settings)
    const ev = extractMarketEvents(dump.payload, points, market, half).filter(
      (e) => !isStoppageClock(e.min, e.period),
    )
    events += ev.length
    const usable = fired.filter((a) => {
      const same = ev.some((g) => g.period === a.period && g.min === a.min && g.side === a.side)
      if (same) coincident += 1
      return !same
    })
    alerts += usable.length
    const lite = usable.map((a) => ({
      min: a.min,
      period: a.period,
      side: a.side,
      coincident: false,
    }))
    for (const alert of usable) {
      const out = outcomeForAlert(alert, ev, points, horizon)
      const lead = out.leadTime5 ?? out.leadTimeLong
      if (isUsableLead(out.leadTime5) || isUsableLead(out.leadTimeLong)) {
        hits += 1
        const used = isUsableLead(out.leadTime5) ? out.leadTime5 : out.leadTimeLong
        leads.push(used)
        leadHist[String(used)] = (leadHist[String(used)] ?? 0) + 1
        if (isPreferredLead(used)) preferredHits += 1
      } else if (lead === 0) {
        leadHist['0'] = (leadHist['0'] ?? 0) + 1
      }
    }
    for (const event of ev) {
      const pre = lite.some((a) => {
        if (a.side !== event.side) return false
        const out = outcomeForAlert(a, [event], points, horizon)
        return isUsableLead(out.leadTime5) || isUsableLead(out.leadTimeLong)
      })
      if (pre) eventsHit += 1
    }
  }

  const n = Math.max(1, dumps.length)
  return {
    matches: dumps.length,
    events,
    alerts,
    alertsPerMatch: alerts / n,
    hits,
    preferredHits,
    eventsHit,
    precision: alerts ? hits / alerts : null,
    precisionPreferred: alerts ? preferredHits / alerts : null,
    recall: events ? eventsHit / events : null,
    medianLead: median(leads),
    meanLead: leads.length ? leads.reduce((a, b) => a + b, 0) / leads.length : null,
    leadHist,
    coincident,
  }
}

function candidatesFor(base: AlertSettings): AlertSettings[] {
  const out: AlertSettings[] = []
  const half = base.cornerHalf
  const kinds: Array<{ primary: RuleKind; secondary: RuleKind; fallback: RuleKind }> = [
    {
      primary: base.primaryKind,
      secondary: base.secondaryKind,
      fallback: base.fallbackKind,
    },
  ]
  if (base.market === 'goals') {
    kinds.push({
      primary: 'combo',
      secondary: 'sustained',
      fallback: 'swing',
    })
  }

  const spikes = around(base.spikeThreshold, 5, base.market === 'corners' ? 50 : 70, 90)
  const swings = around(base.swingComboThreshold, 10, 30, 70)
  const swing2 = around(base.swingSecondaryThreshold, 10, 40, 70)
  const sustT = around(base.sustainedThreshold, 5, 20, 40)
  const sustN = around(base.sustainedComboMinutes, 1, 2, 4)
  const sustSecN = around(base.sustainedSecondaryMinutes, 1, 2, 5)
  const sustSecT = around(base.sustainedSecondaryThreshold, 5, 20, 40)
  const fbSpike = around(base.fallbackSpikeThreshold, 5, 70, 90)
  const fbSustN = around(base.sustainedFallbackMinutes, 1, 3, 5)

  for (const kind of kinds) {
    if (kind.primary === 'combo' || kind.secondary === 'combo') {
      for (const spikeThreshold of spikes) {
        for (const swingComboThreshold of swings) {
          for (const sustainedThreshold of [base.sustainedThreshold, ...sustT].filter(
            (v, i, a) => a.indexOf(v) === i,
          ).slice(0, 3)) {
            for (const sustainedComboMinutes of sustN.slice(0, 3)) {
              out.push({
                ...base,
                ...kind,
                spikeThreshold,
                swingComboThreshold,
                sustainedThreshold,
                sustainedComboMinutes,
                fallbackSustainedThreshold: sustainedThreshold,
                cornerHalf: half,
              })
            }
          }
        }
      }
    }
    if (kind.secondary === 'swing' || kind.fallback === 'swing') {
      for (const swingSecondaryThreshold of swing2) {
        out.push({
          ...base,
          ...kind,
          swingSecondaryThreshold,
          cornerHalf: half,
        })
      }
    }
    if (kind.primary === 'sustained' || kind.secondary === 'sustained') {
      for (const sustainedSecondaryThreshold of sustSecT.slice(0, 3)) {
        for (const sustainedSecondaryMinutes of sustSecN.slice(0, 3)) {
          out.push({
            ...base,
            ...kind,
            sustainedSecondaryThreshold,
            sustainedSecondaryMinutes,
            cornerHalf: half,
          })
        }
      }
    }
    if (kind.fallback === 'spike') {
      for (const fallbackSpikeThreshold of fbSpike) {
        out.push({ ...base, ...kind, fallbackSpikeThreshold, cornerHalf: half })
      }
    }
    if (kind.fallback === 'sustainedFallback') {
      for (const sustainedFallbackMinutes of fbSustN) {
        out.push({ ...base, ...kind, sustainedFallbackMinutes, cornerHalf: half })
      }
    }
  }

  const seen = new Set<string>()
  const unique: AlertSettings[] = []
  for (const row of out) {
    const key = JSON.stringify({
      k: [row.primaryKind, row.secondaryKind, row.fallbackKind],
      t: [
        row.spikeThreshold,
        row.swingComboThreshold,
        row.swingSecondaryThreshold,
        row.sustainedThreshold,
        row.sustainedComboMinutes,
        row.sustainedSecondaryThreshold,
        row.sustainedSecondaryMinutes,
        row.fallbackSpikeThreshold,
        row.fallbackSustainedThreshold,
        row.sustainedFallbackMinutes,
      ],
    })
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  return unique
}

function search(dumps: Dump[], base: AlertSettings): Candidate {
  const baseline = evaluateBucket(dumps, base)
  let best: Candidate = { settings: base, metrics: baseline, score: scoreOf(baseline) }
  const list = candidatesFor(base)
  let i = 0
  for (const settings of list) {
    i += 1
    const metrics = evaluateBucket(dumps, settings)
    const score = scoreOf(metrics)
    if (score > best.score) best = { settings, metrics, score }
    if (i % 40 === 0) {
      console.log(
        `  ${base.market}/${base.cornerHalf} ${i}/${list.length} best=${best.score.toFixed(3)}`,
      )
    }
  }
  return best
}

function pickDumps(all: Dump[]): Dump[] {
  const byDate = new Map<string, Dump[]>()
  for (const row of all) {
    const d = row.date ?? 'unknown'
    const list = byDate.get(d) ?? []
    list.push(row)
    byDate.set(d, list)
  }
  const picked: Dump[] = []
  const capPerDay = 80
  for (const [, list] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const ranked = [...list].sort(
      (a, b) =>
        (b.payload.events?.filter((e) => e.type === 4).length ?? 0) -
        (a.payload.events?.filter((e) => e.type === 4).length ?? 0),
    )
    picked.push(...ranked.slice(0, capPerDay))
  }
  return picked
}

function snapshot(s: AlertSettings) {
  return {
    cornerHalf: s.cornerHalf,
    primaryKind: s.primaryKind,
    secondaryKind: s.secondaryKind,
    fallbackKind: s.fallbackKind,
    spikeThreshold: s.spikeThreshold,
    swingComboThreshold: s.swingComboThreshold,
    swingSecondaryThreshold: s.swingSecondaryThreshold,
    sustainedThreshold: s.sustainedThreshold,
    sustainedComboMinutes: s.sustainedComboMinutes,
    sustainedFallbackMinutes: s.sustainedFallbackMinutes,
    fallbackSpikeThreshold: s.fallbackSpikeThreshold,
    fallbackSustainedThreshold: s.fallbackSustainedThreshold,
    sustainedSecondaryThreshold: s.sustainedSecondaryThreshold,
    sustainedSecondaryMinutes: s.sustainedSecondaryMinutes,
    evaluationWindow: s.evaluationWindow,
  }
}

function fmtPct(n: number | null): string {
  if (n === null) return '—'
  return `${(n * 100).toFixed(1)}%`
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const all = loadDumps()
  const dumps = pickDumps(all)
  const dates = [...new Set(dumps.map((d) => d.date ?? '?'))].sort()
  console.log(`dumps ${all.length} usable, sample ${dumps.length}, dates ${dates[0]}→${dates.at(-1)}`)

  const buckets: Array<{ market: Market; half: CornerHalf }> = [
    { market: 'goals', half: 'ht' },
    { market: 'goals', half: 'ft' },
    { market: 'corners', half: 'ht' },
    { market: 'corners', half: 'ft' },
  ]

  const results: Record<string, { baseline: Candidate; best: Candidate; window: unknown }> = {}
  for (const { market, half } of buckets) {
    const base = defaultsFor(market, half)
    console.log(`\n== ${market} ${half} ==`)
    const baselineMetrics = evaluateBucket(dumps, base)
    const baseline: Candidate = {
      settings: base,
      metrics: baselineMetrics,
      score: scoreOf(baselineMetrics),
    }
    console.log(
      `baseline alerts/jogo=${baselineMetrics.alertsPerMatch.toFixed(2)} prec=${fmtPct(baselineMetrics.precision)} prec12=${fmtPct(baselineMetrics.precisionPreferred)} rec=${fmtPct(baselineMetrics.recall)} medLead=${baselineMetrics.medianLead}`,
    )
    const best = search(dumps, base)
    console.log(
      `best score=${best.score.toFixed(3)} prec=${fmtPct(best.metrics.precision)} prec12=${fmtPct(best.metrics.precisionPreferred)} rec=${fmtPct(best.metrics.recall)} medLead=${best.metrics.medianLead} kinds=${best.settings.primaryKind}/${best.settings.secondaryKind}/${best.settings.fallbackKind}`,
    )
    const window = market === 'corners' ? CORNER_WINDOWS[half] : GOAL_WINDOWS[half]
    results[`${market}_${half}`] = { baseline, best, window }
  }

  const json = {
    generatedAt: new Date().toISOString(),
    dataset: {
      source: 'backtest-data/matches/*.json',
      fetchedFrom: 'SuperScore fixtures by-date/ro + attacking-momentum',
      timezone: 'Europe/Lisbon',
      dateFrom: dates[0],
      dateTo: dates.at(-1),
      filesOnDisk: all.length,
      sampled: dumps.length,
      sampleRule: 'até 80 jogos/dia, preferência a mais golos type=4, timeline≥80',
      demosNotIncluded: ['public/demo/celtic-ferenc-momentum.json', 'public/demo/drava-bistrica-momentum.json'],
      note: 'train_*.py não está no repo; o backtest reutiliza evaluateAlerts/rules.ts (o mesmo caminho do poller). O único script Python referido em treinos anteriores era train_corners_windowed.py, offline e não commitado.',
    },
    constraints: {
      minLead: MIN_LEAD_MIN,
      preferredLead: [MIN_LEAD_MIN, PREFERRED_LEAD_MAX],
      stoppageBan: 'period===1 && min>45 OR period===2 && min>90',
      windows: {
        goals: { ht: GOAL_WINDOWS.ht, ft: GOAL_WINDOWS.ft },
        corners: { ht: CORNER_WINDOWS.ht, ft: CORNER_WINDOWS.ft },
      },
    },
    results: Object.fromEntries(
      Object.entries(results).map(([key, row]) => [
        key,
        {
          window: row.window,
          baseline: { score: row.baseline.score, settings: snapshot(row.baseline.settings), metrics: row.baseline.metrics },
          best: { score: row.best.score, settings: snapshot(row.best.settings), metrics: row.best.metrics },
        },
      ]),
    ),
  }
  writeFileSync(join(OUT_DIR, 'backtest-results.json'), JSON.stringify(json, null, 2))

  const lines: string[] = []
  lines.push('# Backtest SuperScore · 18/set/2026')
  lines.push('')
  lines.push('## Dataset')
  lines.push('')
  lines.push(`- Ficheiros: \`backtest-data/matches/*.json\` (${all.length} jogos com timeline≥80).`)
  lines.push(`- Amostra usada: **${dumps.length}** jogos (máx. 80/dia, preferência a mais golos).`)
  lines.push(`- Datas (Europe/Lisbon): **${dates[0]} → ${dates.at(-1)}**.`)
  lines.push('- Fonte: SuperScore `fixtures/by-date/ro` + `attacking-momentum`. Região `pt`/`uk` devolveu 0 jogos nestas datas.')
  lines.push('- Demos Celtic/Drava **não** entram no grid (só verificação).')
  lines.push('- Não existe `train_*.py` neste repo. O treino reutiliza `evaluateAlerts` / `rules.ts` (caminho real do poller). Relatórios antigos citavam `train_corners_windowed.py` offline, não commitado.')
  lines.push('')
  lines.push('## Constrangimentos')
  lines.push('')
  lines.push(`- Lead útil: **≥ ${MIN_LEAD_MIN} min**. Lead 0 e pós-evento **não** contam.`)
  lines.push(`- Banda preferida para o score: **${MIN_LEAD_MIN}–${PREFERRED_LEAD_MAX} min**.`)
  lines.push('- Prolongamento banido: `P1 min>45` / `P2 min>90`.')
  lines.push('- Janelas propostas (absolutas): Golos HT 20–42 / FT 70–90; Cantos HT 32–42 / FT 82–87.')
  lines.push('')
  lines.push('## Resultados por balde')
  lines.push('')
  for (const key of ['goals_ht', 'goals_ft', 'corners_ht', 'corners_ft']) {
    const row = json.results[key]
    lines.push(`### ${key}`)
    lines.push('')
    lines.push(`Janela: **${row.window.shortLabel}** (period ${row.window.period}, ${row.window.from}–${row.window.to}).`)
    lines.push('')
    lines.push('| | Score | Prec (≥1) | Prec (1–2) | Recall | Alertas/jogo | Med lead | Coinc. |')
    lines.push('|---|---:|---:|---:|---:|---:|---:|---:|')
    const b = row.baseline.metrics
    const t = row.best.metrics
    lines.push(
      `| Baseline | ${row.baseline.score.toFixed(3)} | ${fmtPct(b.precision)} | ${fmtPct(b.precisionPreferred)} | ${fmtPct(b.recall)} | ${b.alertsPerMatch.toFixed(2)} | ${b.medianLead ?? '—'} | ${b.coincident} |`,
    )
    lines.push(
      `| Escolhido | ${row.best.score.toFixed(3)} | ${fmtPct(t.precision)} | ${fmtPct(t.precisionPreferred)} | ${fmtPct(t.recall)} | ${t.alertsPerMatch.toFixed(2)} | ${t.medianLead ?? '—'} | ${t.coincident} |`,
    )
    lines.push('')
    const s = row.best.settings
    lines.push(
      `- Regras: primária \`${s.primaryKind}\`, secundária \`${s.secondaryKind}\`, reserva \`${s.fallbackKind}\`.`,
    )
    lines.push(
      `- Limiares: Spike ${s.spikeThreshold}, Swing combo ${s.swingComboThreshold}, Swing sec. ${s.swingSecondaryThreshold}, Sust ${s.sustainedComboMinutes}@${s.sustainedThreshold}, Sust sec. ${s.sustainedSecondaryMinutes}@${s.sustainedSecondaryThreshold}, Reserva spike ${s.fallbackSpikeThreshold} / sust ${s.sustainedFallbackMinutes}@${s.fallbackSustainedThreshold}, W=${s.evaluationWindow}.`,
    )
    lines.push(`- Distribuição de lead (escolhido): \`${JSON.stringify(t.leadHist)}\`.`)
    lines.push('')
  }
  lines.push('## Notas de adopção')
  lines.push('')
  lines.push('Os limiares escolhidos entram em `src/lib/market.ts`. As janelas ficam em `src/lib/windows.ts`. Definições passam a **locked** (`DEFINITIONS_LOCKED`): a UI avisa em pt-PT e o apply da aprendizagem exige `{ confirm: true, unlock: true }`.')
  lines.push('')
  writeFileSync(join(OUT_DIR, 'BACKTEST.md'), lines.join('\n'))
  writeFileSync(join(ROOT, 'docs', 'backtest-2026-09-18.md'), lines.join('\n'))
  console.log('\nWrote backtest-data/BACKTEST.md and docs/backtest-2026-09-18.md')
}

await main()
