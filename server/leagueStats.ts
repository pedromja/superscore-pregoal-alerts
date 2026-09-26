/**
 * League hit-rate line for Telegram alerts: `📊 Liga (golos): 4/6 · 67 %`.
 *
 * Sample = every stored locked-rule alert (primary/secondary/fallback, sent or
 * not — the quality overlay does not change a rule's outcome) of the same
 * league and market (both halves together) that is settled GREEN/RED, not
 * VOID and not coincident. The current alert is excluded. League key = the
 * league follow-up key (`leagueKeyOf(fixture.competition)`).
 *
 * Kept as an in-memory index so the send path is an O(1) lookup:
 *  - `noteFixtureLeague` (store.saveMatch, every tick) maps fixture → league;
 *  - `observeAlerts` (store.saveAlerts) diffs each alert's contribution, so a
 *    settle / VOID updates the counts where it is written;
 *  - `primeLeagueStats` fills the index once at boot, off the tick.
 * Until an alert's league is known it waits in `unresolved` (per fixture).
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { marketCopy, parseMarket } from '../src/lib/market.ts'
import { leagueKeyOf } from '../src/lib/tips.ts'
import { parseCornerHalf } from '../src/lib/windows.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { telegramLeagueStatsEnabled, telegramLeagueStatsMin } from './config.ts'
import type { LoggedAlert } from './types.ts'

type Contribution = { bucket: string; green: boolean }
type Pending = { market: Market; green: boolean }
export type LeagueStats = { green: number; settled: number }

const fixtureLeague = new Map<string, string>()
const contrib = new Map<string, Contribution>()
const buckets = new Map<string, LeagueStats>()
/** fixtureId → contribution key → waiting contribution (league unknown yet). */
const unresolved = new Map<string, Map<string, Pending>>()
/**
 * scope (market|half) → alert id → last seen state. `sig` = -1 not counted,
 * 0 RED, 1 GREEN; `resolved` = league known. `gen` marks the last save that
 * listed the alert, so removed alerts can be dropped without a second map.
 */
type SeenAlert = { fixtureId: string; sig: number; resolved: boolean; gen: number }
const scopeKeys = new Map<string, Map<string, SeenAlert>>()
let generation = 0
let primed = false
let priming: Promise<void> | null = null

function bucketKey(market: Market, league: string): string {
  return `${parseMarket(market)}|${league}`
}

/** Key per stored alert: market + store scope half + alert id. */
export function leagueContribKey(
  market: Market,
  half: CornerHalf | null | undefined,
  alertId: string,
): string {
  return `${parseMarket(market)}|${parseCornerHalf(half)}|${alertId}`
}

function addTo(bucket: string, green: boolean, delta: 1 | -1): void {
  const row = buckets.get(bucket) ?? { green: 0, settled: 0 }
  row.settled += delta
  if (green) row.green += delta
  if (row.settled <= 0) buckets.delete(bucket)
  else buckets.set(bucket, row)
}

function dropUnresolved(fixtureId: string, key: string): void {
  const waiting = unresolved.get(fixtureId)
  if (!waiting) return
  waiting.delete(key)
  if (!waiting.size) unresolved.delete(fixtureId)
}

function setContribution(key: string, next: Contribution | null): void {
  const prev = contrib.get(key)
  if (prev && next && prev.bucket === next.bucket && prev.green === next.green) return
  if (prev) addTo(prev.bucket, prev.green, -1)
  if (next) {
    addTo(next.bucket, next.green, 1)
    contrib.set(key, next)
  } else {
    contrib.delete(key)
  }
}

/** Settled GREEN/RED, not VOID, not coincident. */
export function countsForLeague(
  alert: Pick<LoggedAlert, 'hit5' | 'hitLong' | 'void' | 'coincident'>,
): { green: boolean } | null {
  if (alert.void || alert.coincident) return null
  if (alert.hit5 == null && alert.hitLong == null) return null
  return { green: alert.hit5 === true || alert.hitLong === true }
}

export function leagueForFixture(fixtureId: string): string | null {
  return fixtureLeague.get(fixtureId) ?? null
}

/** store.saveMatch: remember the fixture's league and resolve waiting alerts. */
export function noteFixtureLeague(fixtureId: string, competition: string | null | undefined): void {
  if (!fixtureId || fixtureLeague.has(fixtureId)) return
  const league = leagueKeyOf(competition)
  fixtureLeague.set(fixtureId, league)
  const waiting = unresolved.get(fixtureId)
  if (!waiting) return
  unresolved.delete(fixtureId)
  for (const [key, p] of waiting) {
    setContribution(key, { bucket: bucketKey(p.market, league), green: p.green })
  }
}

/**
 * store.saveAlerts: update the counts from the scope's full alert list
 * (the file is always written whole, so missing ids were removed). Only
 * alerts whose outcome/VOID/league changed touch the index.
 */
export function observeAlerts(
  alerts: LoggedAlert[],
  market: Market,
  half?: CornerHalf | null,
): void {
  const m = parseMarket(market)
  const h = parseCornerHalf(half)
  const scope = `${m}|${h}`
  let state = scopeKeys.get(scope)
  if (!state) {
    state = new Map<string, SeenAlert>()
    scopeKeys.set(scope, state)
  }
  generation += 1
  const gen = generation
  let listed = 0
  for (const alert of alerts) {
    const counted = countsForLeague(alert)
    const sig = counted ? (counted.green ? 1 : 0) : -1
    const prev = state.get(alert.id)
    if (prev) {
      if (prev.gen !== gen) listed += 1
      prev.gen = gen
      if (prev.sig === sig && (prev.resolved || sig < 0)) continue
    } else {
      listed += 1
    }
    const key = `${scope}|${alert.id}`
    const entry: SeenAlert = prev ?? { fixtureId: alert.fixtureId, sig, resolved: false, gen }
    entry.sig = sig
    if (!counted) {
      entry.resolved = false
      if (contrib.has(key)) setContribution(key, null)
      dropUnresolved(alert.fixtureId, key)
    } else {
      const known = fixtureLeague.get(alert.fixtureId)
      const league = known ?? (alert.odds?.league ? leagueKeyOf(alert.odds.league) : null)
      if (!league) {
        entry.resolved = false
        if (contrib.has(key)) setContribution(key, null)
        const waiting = unresolved.get(alert.fixtureId) ?? new Map<string, Pending>()
        waiting.set(key, { market: m, green: counted.green })
        unresolved.set(alert.fixtureId, waiting)
      } else {
        entry.resolved = true
        dropUnresolved(alert.fixtureId, key)
        setContribution(key, { bucket: bucketKey(m, league), green: counted.green })
      }
    }
    if (!prev) state.set(alert.id, entry)
  }
  if (state.size === listed) return
  for (const [id, entry] of state) {
    if (entry.gen === gen) continue
    const key = `${scope}|${id}`
    if (contrib.has(key)) setContribution(key, null)
    dropUnresolved(entry.fixtureId, key)
    state.delete(id)
  }
}

/** O(1): counts for league+market, minus `excludeKey` if it is in the sample. */
export function leagueStatsFor(
  market: Market,
  league: string | null | undefined,
  excludeKey?: string,
): LeagueStats {
  const bucket = bucketKey(market, leagueKeyOf(league))
  const row = buckets.get(bucket) ?? { green: 0, settled: 0 }
  let { green, settled } = row
  const own = excludeKey ? contrib.get(excludeKey) : undefined
  if (own && own.bucket === bucket) {
    settled -= 1
    if (own.green) green -= 1
  }
  return { green, settled }
}

/** `📊 Liga (golos): 4/6 · 67 %`, or null below the minimum sample. */
export function formatLeagueLine(
  market: Market,
  stats: LeagueStats,
  min = telegramLeagueStatsMin(),
): string | null {
  if (stats.settled < Math.max(1, min)) return null
  const pct = Math.round((100 * stats.green) / stats.settled)
  const noun = marketCopy(parseMarket(market)).nounPlural
  return `📊 Liga (${noun}): ${stats.green}/${stats.settled} · ${pct} %`
}

/** Line for an alert about to be sent (null = no line). Never throws. */
export function leagueLineForAlert(args: {
  market: Market
  fixtureId: string
  competition: string | null | undefined
  half?: CornerHalf | null
  alertId: string
}): string | null {
  if (!telegramLeagueStatsEnabled() || !primed) return null
  try {
    noteFixtureLeague(args.fixtureId, args.competition)
    const league = fixtureLeague.get(args.fixtureId) ?? leagueKeyOf(args.competition)
    const stats = leagueStatsFor(
      args.market,
      league,
      leagueContribKey(args.market, args.half, args.alertId),
    )
    return formatLeagueLine(args.market, stats)
  } catch (err) {
    console.warn('[league] line', err instanceof Error ? err.message : err)
    return null
  }
}

export type LeagueStatsLoaders = {
  matchesDir: string
  loadAlerts: (market: Market, half: CornerHalf) => LoggedAlert[]
}

/**
 * Boot-time fill: fixture leagues from the stored match snapshots (async,
 * yields between files), then one pass over the four alert scopes.
 */
export function primeLeagueStats(loaders: LeagueStatsLoaders): Promise<void> {
  if (priming) return priming
  priming = (async () => {
    const started = Date.now()
    let files: string[] = []
    try {
      files = (await readdir(loaders.matchesDir)).filter((f) => f.endsWith('.json'))
    } catch {
      files = []
    }
    for (const file of files) {
      const id = file.slice(0, -5)
      if (fixtureLeague.has(id)) continue
      try {
        const raw = JSON.parse(await readFile(join(loaders.matchesDir, file), 'utf8')) as {
          fixture?: { id?: string; competition?: string }
        }
        noteFixtureLeague(raw.fixture?.id ?? id, raw.fixture?.competition)
      } catch {
        // partial/corrupt snapshot: league stays unknown for that fixture
      }
    }
    for (const market of ['goals', 'corners'] as const) {
      for (const half of ['ht', 'ft'] as const) {
        observeAlerts(loaders.loadAlerts(market, half), market, half)
        await new Promise((r) => setImmediate(r))
      }
    }
    primed = true
    console.log(
      `[league] index pronto em ${Date.now() - started} ms: ${fixtureLeague.size} jogos, ${contrib.size} alertas resolvidos, ${summarizeLeagueStats(3).map((r) => `${r.market} ${r.leagues}`).join(' · ')} ligas ≥3`,
    )
  })()
  return priming
}

export function leagueStatsReady(): boolean {
  return primed
}

/** Leagues per market with at least `min` settled alerts (ops / report). */
export function summarizeLeagueStats(min = 3): { market: Market; leagues: number }[] {
  const out = new Map<Market, number>([
    ['goals', 0],
    ['corners', 0],
  ])
  for (const [bucket, row] of buckets) {
    if (row.settled < min) continue
    const market = parseMarket(bucket.split('|')[0])
    out.set(market, (out.get(market) ?? 0) + 1)
  }
  return [...out].map(([market, leagues]) => ({ market, leagues }))
}

export function leagueStatsSnapshot(): { market: Market; league: string; green: number; settled: number }[] {
  return [...buckets].map(([bucket, row]) => {
    const [market, ...rest] = bucket.split('|')
    return { market: parseMarket(market), league: rest.join('|'), ...row }
  })
}

export function resetLeagueStatsForTests(opts: { primed?: boolean } = {}): void {
  fixtureLeague.clear()
  contrib.clear()
  buckets.clear()
  unresolved.clear()
  scopeKeys.clear()
  priming = null
  primed = opts.primed ?? false
}
