/**
 * Revalidate SuperScore lead metrics against the SokkerPro event clock.
 *
 * SuperScore momentum still fires alerts. Ground-truth minutes come from
 * GET /fixture/{id} `timeline` (type 14/16 golos, 126 cantos). The mini board
 * has no historical event list.
 *
 * Usage:
 *   npx tsx scripts/revalidate-clock.ts
 *   npx tsx scripts/revalidate-clock.ts --max-per-day=25
 *   npx tsx scripts/revalidate-clock.ts --offline   # published hist + local dumps only
 *
 * Does NOT unlock or write locked windows / thresholds.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  recommendClockFix,
  revalidateBucket,
  pairEventClocks,
  rawSuperscoreEvents,
  shiftPublishedLeadHist,
  type ClockCompareRow,
  type ClockPairing,
  type SensitivityRow,
} from '../src/lib/clockRevalidate.ts'
import { flattenFixtures } from '../src/lib/api.ts'
import { matchSokkerProFixtureOriented } from '../src/lib/sokkerpro.ts'
import {
  hasSokkerEventTimeline,
  sokkerEventsAsGoals,
  type SokkerFixtureDetail,
} from '../src/lib/sokkerTimeline.ts'
import type { Fixture, Market, MomentumPayload } from '../src/lib/types.ts'
import { inCornerWindow, inGoalsWindow, isStoppageClock } from '../src/lib/windows.ts'
import { DEFINITIONS_LOCKED } from '../src/lib/lock.ts'
import { fetchSokkerProBoard, fetchSokkerProFixtureDetail } from '../server/sokkerpro.ts'

const ROOT = join(import.meta.dirname, '..')
const MATCH_DIR = join(ROOT, 'backtest-data', 'matches')
const OUT_JSON = join(ROOT, 'docs', 'clock-revalidation.json')
const OUT_MD = join(ROOT, 'docs', 'clock-revalidation.md')
const PUBLISHED = join(ROOT, 'backtest-data', 'backtest-results.json')

const START = '2026-09-08'
const END = '2026-09-18'
const REGION = 'ro'
const DEFAULT_MAX_PER_DAY = 25
const CONCURRENCY = 5

type Dump = {
  fixture: { id: string; team1: string; team2: string; competition: string; dateSeconds?: number }
  payload: MomentumPayload
  date?: string
}

type PublishedBucket = {
  best: { metrics: { alerts: number; leadHist: Record<string, number>; precision: number; precisionPreferred: number; medianLead: number | null } }
}

function argVal(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`)
}

function datesInclusive(from: string, to: string): string[] {
  const out: string[] = []
  const cur = new Date(`${from}T12:00:00Z`)
  const last = new Date(`${to}T12:00:00Z`)
  while (cur <= last) {
    out.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return out
}

function fmtPct(n: number | null | undefined): string {
  if (n == null) return '—'
  return `${(n * 100).toFixed(1)}%`
}

function fmtN(n: number | null | undefined, digits = 2): string {
  if (n == null) return '—'
  return n.toFixed(digits)
}

async function fetchJson(url: string, timeoutMs = 20_000): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  const text = await res.text()
  if (!text.trim()) throw new Error(`empty ${url}`)
  return JSON.parse(text)
}

async function pool<T, R>(items: T[], n: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i
      i += 1
      out[idx] = await fn(items[idx])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

function loadLocalDumps(): Dump[] {
  if (!existsSync(MATCH_DIR)) return []
  const files = readdirSync(MATCH_DIR).filter((n) => n.endsWith('.json'))
  const out: Dump[] = []
  for (const file of files) {
    try {
      const raw = JSON.parse(readFileSync(join(MATCH_DIR, file), 'utf8')) as Dump
      if ((raw.payload?.timeline?.length ?? 0) < 80) continue
      out.push(raw)
    } catch {
      /* skip */
    }
  }
  return out
}

function loadPublished(): Record<string, PublishedBucket> | null {
  if (!existsSync(PUBLISHED)) return null
  try {
    const raw = JSON.parse(readFileSync(PUBLISHED, 'utf8')) as {
      results: Record<string, PublishedBucket>
    }
    return raw.results
  } catch {
    return null
  }
}

function publishedSensitivity(
  results: Record<string, PublishedBucket>,
): Record<string, SensitivityRow[]> {
  const out: Record<string, SensitivityRow[]> = {}
  for (const [key, row] of Object.entries(results)) {
    const m = row.best.metrics
    out[key] = [1, 2].map((d) => shiftPublishedLeadHist(m.leadHist, d, m.alerts))
  }
  return out
}

async function probeAvailability(): Promise<{
  miniHasTimeline: boolean
  detailHasTimeline: boolean
  miniNote: string
  detailNote: string
  sampleFixtureId: string | null
}> {
  try {
    const board = await fetchSokkerProBoard('2026-09-18')
    const first = board?.[0]
    const miniHas = Boolean(
      first && 'timeline' in first && Array.isArray((first as { timeline?: unknown }).timeline),
    )
    let detailHas = false
    let detailNote = 'sem fixture para /fixture/{id}'
    let sampleId: string | null = first?.fixtureId ?? null
    if (sampleId) {
      const detail = await fetchSokkerProFixtureDetail(sampleId)
      detailHas = hasSokkerEventTimeline(detail)
      detailNote = detailHas
        ? `/fixture/{id} timeline com ${detail?.timeline.length ?? 0} eventos (golos type 14/16, cantos 126)`
        : '/fixture/{id} sem timeline de eventos'
    }
    return {
      miniHasTimeline: miniHas,
      detailHasTimeline: detailHas,
      miniNote: miniHas
        ? 'mini board inesperadamente tem timeline'
        : 'mini board: só marcador / is_goal / minuto — sem lista de golos ou cantos',
      detailNote,
      sampleFixtureId: sampleId,
    }
  } catch (err) {
    return {
      miniHasTimeline: false,
      detailHasTimeline: false,
      miniNote: `probe mini falhou: ${err instanceof Error ? err.message : err}`,
      detailNote: 'probe detail não correu',
      sampleFixtureId: null,
    }
  }
}

async function fetchSsFixtures(date: string): Promise<Fixture[]> {
  const params = new URLSearchParams({
    language: 'en',
    date,
    timezone_offset: '1',
  })
  const url = `https://api.content-prod.superscore.live/v2/public/stats/fixtures/by-date/${REGION}?${params}`
  const raw = await fetchJson(url)
  return flattenFixtures(raw as Parameters<typeof flattenFixtures>[0])
}

async function fetchMomentum(id: string): Promise<MomentumPayload> {
  const url = `https://scorealarm-stats.freetls.fastly.net/v2/soccer/fixtures/attacking-momentum/superscore/en?fixture-id=${encodeURIComponent(id)}`
  const raw = (await fetchJson(url)) as MomentumPayload
  if (!raw?.timeline?.length) throw new Error(`no timeline ${id}`)
  return raw
}

type MatchedRow = {
  dump: Dump
  detail: SokkerFixtureDetail
  swapped: boolean
  nameScore: number
}

async function collectMatched(
  offline: boolean,
  maxPerDay: number,
): Promise<{ rows: MatchedRow[]; notes: string[] }> {
  const notes: string[] = []
  const local = loadLocalDumps()
  if (local.length) {
    notes.push(`dumps locais: ${local.length} em backtest-data/matches/`)
  } else {
    notes.push('backtest-data/matches/ vazio (gitignored) — a amostra original de 880 jogos não está no repo')
  }

  if (offline && !local.length) {
    notes.push('--offline sem dumps: só sensitivity + gap analysis')
    return { rows: [], notes }
  }

  const byDate = new Map<string, Dump[]>()
  if (local.length) {
    for (const dump of local) {
      const d = dump.date ?? 'unknown'
      const list = byDate.get(d) ?? []
      list.push(dump)
      byDate.set(d, list)
    }
  }

  const dates = local.length
    ? [...byDate.keys()].filter((d) => d !== 'unknown').sort()
    : datesInclusive(START, END)
  const picked: Dump[] = []

  if (local.length) {
    for (const date of dates) {
      const list = (byDate.get(date) ?? []).sort(
        (a, b) =>
          (b.payload.events?.filter((e) => e.type === 4).length ?? 0) -
          (a.payload.events?.filter((e) => e.type === 4).length ?? 0),
      )
      picked.push(...list.slice(0, maxPerDay))
    }
  } else if (!offline) {
    for (const date of dates) {
      try {
        const fixtures = (await fetchSsFixtures(date)).filter(
          (f) => f.state === 2 || f.status >= 100 || f.scoreIsFt,
        )
        const board = (await fetchSokkerProBoard(date)) ?? []
        const matched = fixtures
          .map((fixture) => {
            const hit = matchSokkerProFixtureOriented(
              board,
              fixture.team1,
              fixture.team2,
              fixture.dateSeconds || null,
            )
            return hit ? { fixture, hit } : null
          })
          .filter((row): row is NonNullable<typeof row> => Boolean(row))
          .slice(0, maxPerDay)
        notes.push(`${date}: SuperScore FT ${fixtures.length}, emparelhados mini ${matched.length}`)
        const dumps = await pool(matched, CONCURRENCY, async ({ fixture }) => {
          try {
            const payload = await fetchMomentum(fixture.id)
            if ((payload.timeline?.length ?? 0) < 80) return null
            const dump: Dump = {
              fixture,
              payload,
              date,
            }
            return dump
          } catch {
            return null
          }
        })
        picked.push(...dumps.filter((d): d is Dump => Boolean(d)))
      } catch (err) {
        notes.push(`${date} fetch falhou: ${err instanceof Error ? err.message : err}`)
      }
    }
  }

  const rows: MatchedRow[] = []
  await pool(picked, CONCURRENCY, async (dump) => {
    const date = dump.date ?? START
    const board = (await fetchSokkerProBoard(date)) ?? []
    const hit = matchSokkerProFixtureOriented(
      board,
      dump.fixture.team1,
      dump.fixture.team2,
      dump.fixture.dateSeconds ?? null,
    )
    if (!hit) return
    const detail = await fetchSokkerProFixtureDetail(hit.fixture.fixtureId)
    if (!detail || !hasSokkerEventTimeline(detail)) return
    rows.push({
      dump,
      detail,
      swapped: hit.swapped,
      nameScore: hit.nameScore,
    })
  })
  notes.push(`emparelhados com timeline SokkerPro: ${rows.length} / ${picked.length} dumps`)
  return { rows, notes }
}

function pairingForMarket(rows: MatchedRow[], market: Market): ClockPairing {
  const kind = market === 'corners' ? 'corner' : 'goal'
  const inWindow = market === 'corners' ? inCornerWindow : inGoalsWindow
  const ss: ReturnType<typeof rawSuperscoreEvents> = []
  const sp: ReturnType<typeof sokkerEventsAsGoals> = []
  for (const row of rows) {
    ss.push(
      ...rawSuperscoreEvents(row.dump.payload, market).filter(
        (event) => !isStoppageClock(event.min, event.period) && inWindow(event.min, event.period),
      ),
    )
    sp.push(
      ...sokkerEventsAsGoals(row.detail, kind, row.swapped).filter(
        (event) => !isStoppageClock(event.min, event.period) && inWindow(event.min, event.period),
      ),
    )
  }
  return pairEventClocks(ss, sp)
}

function writeReport(doc: unknown, md: string): void {
  mkdirSync(join(ROOT, 'docs'), { recursive: true })
  writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2))
  writeFileSync(OUT_MD, md)
}

function mdTableCompare(row: ClockCompareRow): string[] {
  const o = row.old
  const n = row.neu
  return [
    `| | Prec (≥1) | Prec (1–2) | Med lead | Alertas | Hits | Coinc. / lead<1 |`,
    `|---|---:|---:|---:|---:|---:|---:|`,
    `| SuperScore type=${row.market === 'goals' ? 4 : 14} | ${fmtPct(o.precision)} | ${fmtPct(o.precisionPreferred)} | ${o.medianLead ?? '—'} | ${o.alerts} | ${o.hits} | ${o.coincident} / ${o.leadLt1} |`,
    `| SokkerPro timeline | ${fmtPct(n.precision)} | ${fmtPct(n.precisionPreferred)} | ${n.medianLead ?? '—'} | ${n.alerts} | ${n.hits} | ${n.coincident} / ${n.leadLt1} |`,
    `| Δ | ${fmtPct(row.precisionDelta)} | ${fmtPct(row.precisionPreferredDelta)} | ${row.medianLeadDelta ?? '—'} |  |  | colapso ${row.collapsed.count} (${fmtPct(row.collapsed.shareOfOldHits)} dos hits SS) |`,
  ]
}

async function main() {
  const offline = hasFlag('offline')
  const maxPerDay = Math.max(1, Number(argVal('max-per-day', String(DEFAULT_MAX_PER_DAY))) || DEFAULT_MAX_PER_DAY)
  const published = loadPublished()
  const sensitivity = published ? publishedSensitivity(published) : {}
  const availability = offline
    ? {
        miniHasTimeline: false,
        detailHasTimeline: true,
        miniNote: 'offline: mini não tem timeline (documentado)',
        detailNote: 'offline: /fixture/{id} timeline conhecido (type 14/16/126)',
        sampleFixtureId: null,
      }
    : await probeAvailability()

  const { rows, notes } = await collectMatched(offline, maxPerDay)
  const buckets = rows.length
    ? [
        revalidateBucket(
          rows.map((r) => ({
            payload: r.dump.payload,
            sokkerEvents: sokkerEventsAsGoals(r.detail, 'goal', r.swapped),
          })),
          'goals',
          'ht',
        ),
        revalidateBucket(
          rows.map((r) => ({
            payload: r.dump.payload,
            sokkerEvents: sokkerEventsAsGoals(r.detail, 'goal', r.swapped),
          })),
          'goals',
          'ft',
        ),
        revalidateBucket(
          rows.map((r) => ({
            payload: r.dump.payload,
            sokkerEvents: sokkerEventsAsGoals(r.detail, 'corner', r.swapped),
          })),
          'corners',
          'ht',
        ),
        revalidateBucket(
          rows.map((r) => ({
            payload: r.dump.payload,
            sokkerEvents: sokkerEventsAsGoals(r.detail, 'corner', r.swapped),
          })),
          'corners',
          'ft',
        ),
      ]
    : []
  const pairingGoals = rows.length ? pairingForMarket(rows, 'goals') : null
  const pairingCorners = rows.length ? pairingForMarket(rows, 'corners') : null

  const goalsCompare = buckets.filter((b) => b.market === 'goals')
  const collapsedShare =
    goalsCompare.length && goalsCompare.some((b) => b.collapsed.shareOfOldHits !== null)
      ? goalsCompare.reduce((s, b) => s + (b.collapsed.shareOfOldHits ?? 0), 0) /
        goalsCompare.filter((b) => b.collapsed.shareOfOldHits !== null).length
      : null
  const precisionDelta =
    goalsCompare.length && goalsCompare.some((b) => b.precisionDelta !== null)
      ? goalsCompare.reduce((s, b) => s + (b.precisionDelta ?? 0), 0) /
        goalsCompare.filter((b) => b.precisionDelta !== null).length
      : null

  const recommendation = recommendClockFix({
    matchedMatches: rows.length,
    medianOffset: pairingGoals?.medianOffset ?? null,
    collapsedShare,
    precisionDelta,
    cornersLiveClock: 'none',
    prospectiveReady: true,
  })

  const doc = {
    generatedAt: new Date().toISOString(),
    lockedUntouched: DEFINITIONS_LOCKED === true,
    definitionsLocked: DEFINITIONS_LOCKED,
    dataset: {
      trainingWindow: { from: START, to: END, region: REGION },
      localDumps: loadLocalDumps().length,
      matchedWithSokkerTimeline: rows.length,
      maxPerDay,
      offline,
      notes,
    },
    availability: {
      ...availability,
      cornersLive: 'mini board não tem cantos — live continua SuperScore type=14 (still-suspect)',
      cornersHistorical: 'GET /fixture/{id} timeline type_id=126 tem minutos de canto',
      goalsLive: 'mini: scoresLocalTeam/Visitor + is_goal / is_goal_team + minute (PR #17)',
      goalsHistorical: 'GET /fixture/{id} timeline type_id=14 (golo) e 16 (penálti)',
    },
    publishedSensitivity: sensitivity,
    pairing: {
      goals: pairingGoals ? { ...pairingGoals, paired: undefined } : null,
      corners: pairingCorners ? { ...pairingCorners, paired: undefined } : null,
    },
    buckets,
    recommendation,
    prospective: {
      logFile: 'data/sokker_clock.json',
      alertFields: ['fastScore', 'clockProbe'],
      design: [
        'Cada tick do poller grava o marcador SokkerPro (cache-only) e detecta transições de score.',
        'Cada alerta SuperScore guarda fastScore + clockProbe (is_goal, minuto, tally SS).',
        'lead_spro = sokker_event_min − alert_min (transição ou is_goal). lead_ss continua o actual.',
        'N=50 golos em janela com ambos os relógios: recalcular prec@≥1 / 1–2 / mediana e só então falar com Pedro de params.',
        'Cantos: sem transição no mini. Ficam flagged still-suspect até haver feed de cantos mais rápido.',
      ],
    },
  }

  const lines: string[] = []
  lines.push('# Revalidação do relógio · SuperScore vs SokkerPro')
  lines.push('')
  lines.push(`Gerado: ${doc.generatedAt}. **DEFINITIONS_LOCKED=${DEFINITIONS_LOCKED}** — este relatório não altera janelas nem limiares.`)
  lines.push('')
  lines.push('## Porque é que isto existe')
  lines.push('')
  lines.push('O backtest de 18/set (e a aprendizagem) etiquetam golos `type=4` e cantos `type=14` no JSON de momentum SuperScore. Ao vivo esses marcadores chegam tarde. Lead 1–2′ e precisão@lead no dump FT podem estar **optimistamente enviesados** se o `event.min` SuperScore for mais tarde que o golo real, ou se o dump incorporar o evento só depois do pico.')
  lines.push('')
  lines.push('Momentum SuperScore **mantém-se** para disparar alertas. O relógio de verdade, quando existir, é SokkerPro.')
  lines.push('')
  lines.push('## O que a API SokkerPro dá (e não dá)')
  lines.push('')
  lines.push(`- Mini \`/home/fixtures/{date}/utc/mini\`: ${availability.miniNote}.`)
  lines.push(`- Detail \`/fixture/{id}\`: ${availability.detailNote}.`)
  lines.push('- **Golos ao vivo:** `scores*` + `is_goal` / `is_goal_team` (já usados no gate Telegram, PR #17).')
  lines.push('- **Cantos ao vivo:** o mini **não tem** cantos. Sem feed rápido. Histórico type=126 existe no detail — útil para o estudo offline, **still-suspect** para o live.')
  lines.push('- O mini **não** guarda o histórico de golos do jogo; só o marcador actual. Sem `/fixture/{id}` não há minutos.')
  lines.push('')
  lines.push('## Sensitivity no backtest publicado (sem dumps)')
  lines.push('')
  lines.push('Os 2203 JSON do treino **não estão no git**. Enquanto não houver amostra emparelhada, o bound honesto é: se o stamp SuperScore chegar `D` minutos tarde, cada lead `L` vira `L−D`.')
  lines.push('')
  if (published) {
    lines.push('| Balde | D | Prec≥1 velha → nova | Prec 1–2 velha → nova | Hits perdidos | Med lead velha → nova |')
    lines.push('|---|---:|---:|---:|---:|---:|')
    for (const key of ['goals_ht', 'goals_ft', 'corners_ht', 'corners_ft']) {
      const rowsS = sensitivity[key] ?? []
      for (const s of rowsS) {
        lines.push(
          `| ${key} | ${s.delayMin}′ | ${fmtPct(s.oldPrecision)} → ${fmtPct(s.newPrecision)} | ${fmtPct(s.oldPrecisionPreferred)} → ${fmtPct(s.newPrecisionPreferred)} | ${s.collapsed} (${fmtPct(s.collapsedShare)}) | ${s.medianLeadOld ?? '—'} → ${s.medianLeadNew ?? '—'} |`,
        )
      }
    }
    lines.push('')
    const gh = sensitivity.goals_ht?.[0]
    if (gh) {
      lines.push(
        `Leitura rápida (golos HT, D=1′): **${fmtPct(gh.oldPrecision)} → ${fmtPct(gh.newPrecision)}** precisão@lead≥1; **${gh.collapsed}** dos ${gh.oldHits} hits (quase todos os lead=1) deixam de contar. A banda “1–2′” do score locked é a mais frágil.`,
      )
    }
  } else {
    lines.push('_backtest-results.json em falta._')
  }
  lines.push('')
  lines.push('## Amostra emparelhada SuperScore ↔ SokkerPro')
  lines.push('')
  for (const note of notes) lines.push(`- ${note}`)
  lines.push(`- Jogos com timeline SokkerPro: **${rows.length}**.`)
  if (pairingGoals) {
    lines.push(
      `- Offset golo **dentro das janelas locked** (SS − SP, lado+ordem): mediano **${pairingGoals.medianOffset ?? '—'}′**, média ${fmtN(pairingGoals.meanOffset)}, ${fmtPct(pairingGoals.lateShare)} com SS ≥1′ mais tarde. Por emparelhar: SS ${pairingGoals.unpairedSuperscore} / SP ${pairingGoals.unpairedSokker}. Contagens diferentes = pairing imperfeito; as tabelas por balde é que importam.`,
    )
  }
  if (pairingCorners) {
    lines.push(
      `- Offset canto (histórico type=126, **não** é feed live): mediano **${pairingCorners.medianOffset ?? '—'}′**, ${fmtPct(pairingCorners.lateShare)} SS mais tarde.`,
    )
  }
  lines.push('')
  if (!buckets.length) {
    lines.push('Sem amostra emparelhada nesta corrida — não se afirma o enviesamento real do set de 880, só o bound de sensitivity e o desenho prospectivo.')
    lines.push('')
  } else {
    for (const row of buckets) {
      lines.push(`### ${row.market} ${row.half}`)
      lines.push('')
      lines.push(...mdTableCompare(row))
      lines.push('')
    }
  }
  lines.push('## Estudo prospectivo (já no poller)')
  lines.push('')
  lines.push('- `data/sokker_clock.json` — snapshot do marcador por jogo/tick + transições `score` / `is_goal`.')
  lines.push('- Cada `LoggedAlert` ganha `fastScore` + `clockProbe` (não muda hit/label SuperScore).')
  lines.push('- Quando houver ≥50 golos em janela com os dois relógios: `npx tsx scripts/revalidate-clock.ts` volta a correr e compara.')
  lines.push('- Cantos: não há transição no mini. Ficam **still-suspect** até existir feed de cantos mais rápido.')
  lines.push('')
  lines.push('## Recomendação (Pedro)')
  lines.push('')
  lines.push(`**${recommendation.headlinePt}**`)
  lines.push('')
  for (const d of recommendation.detailPt) lines.push(`- ${d}`)
  lines.push('')
  lines.push('Acção: `' + recommendation.action + '`. Locked intacto. Sem apply silencioso.')
  lines.push('')

  writeReport(doc, lines.join('\n'))
  console.log(`Wrote ${OUT_MD} (${rows.length} matched, action=${recommendation.action})`)
}

await main()
