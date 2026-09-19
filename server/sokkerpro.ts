import { fastScoreFromBoard, type FastScore } from '../src/lib/fastScore.ts'
import {
  parseSokkerFixtureDetail,
  type SokkerFixtureDetail,
} from '../src/lib/sokkerTimeline.ts'
import {
  collectOddsMap,
  flattenMiniFixtures,
  matchSokkerProFixture,
  pickSokkerProMaisUm,
  utcDateKey,
  utcDateKeyDaysAgo,
  type SokkerProFixture,
  type SokkerProPick,
  SOKKERPRO_BOARD_CACHE_MS,
  SOKKERPRO_PREODDS_CACHE_MS,
} from '../src/lib/sokkerpro.ts'
import type { CornerHalf, Fixture, Market } from '../src/lib/types.ts'
import { SOKKERPRO_LIVE_SCORE, SOKKERPRO_ODDS } from './config.ts'

const BASE = (process.env.SOKKERPRO_M2_URL || 'https://m2.sokkerpro.com').replace(/\/$/, '')
/** Mini board is ~1 MB and often slower than preodds. Do not inherit the old 6s default. */
const BOARD_TIMEOUT_MS = Number(process.env.SOKKERPRO_BOARD_TIMEOUT_MS || 25_000)
const PREODDS_TIMEOUT_MS = Number(
  process.env.SOKKERPRO_PREODDS_TIMEOUT_MS || process.env.SOKKERPRO_TIMEOUT_MS || 8_000,
)
const DETAIL_TIMEOUT_MS = Number(process.env.SOKKERPRO_DETAIL_TIMEOUT_MS || 12_000)
const DETAIL_CACHE_MS = Number(process.env.SOKKERPRO_DETAIL_CACHE_MS || 10 * 60_000)
const BOARD_CACHE_MS = Number(
  process.env.SOKKERPRO_BOARD_CACHE_MS || SOKKERPRO_BOARD_CACHE_MS,
)
const PREODDS_CACHE_MS = Number(
  process.env.SOKKERPRO_PREODDS_CACHE_MS || SOKKERPRO_PREODDS_CACHE_MS,
)

type CacheEntry<T> = { ts: number; value: T }
const boardCache = new Map<string, CacheEntry<SokkerProFixture[] | null>>()
const oddsCache = new Map<string, CacheEntry<Record<string, string> | null>>()
const matchCache = new Map<string, CacheEntry<SokkerProMatchOdds | null>>()
const detailCache = new Map<string, CacheEntry<SokkerFixtureDetail | null>>()
const boardInflight = new Map<string, Promise<SokkerProFixture[] | null>>()

let boardFailLoggedThisTick = false
let nowFn = (): Date => new Date()
let fetchFn: typeof fetch = globalThis.fetch.bind(globalThis)
let liveScoreEnabled = SOKKERPRO_LIVE_SCORE
/** Use a slightly stale board for live scores rather than blocking notify. */
const LIVE_SCORE_STALE_MS = Number(process.env.SOKKERPRO_LIVE_STALE_MS || 180_000)

export type SokkerProMatchOdds = {
  fixture: SokkerProFixture
  odds: Record<string, string>
}

export function isSokkerProOddsEnabled(): boolean {
  return SOKKERPRO_ODDS
}

export function isSokkerProLiveScoreEnabled(): boolean {
  return liveScoreEnabled
}

export function isSokkerProBoardEnabled(): boolean {
  return isSokkerProOddsEnabled() || isSokkerProLiveScoreEnabled()
}

/** New poller tick: retry a failed mini board once, keep a successful cache. */
export function beginSokkerProTick(): void {
  boardFailLoggedThisTick = false
  for (const [key, entry] of boardCache) {
    if (entry.value === null) boardCache.delete(key)
  }
}

export async function warmupSokkerProBoard(): Promise<SokkerProFixture[] | null> {
  if (!isSokkerProBoardEnabled()) return null
  beginSokkerProTick()
  try {
    return await fetchSokkerProBoard(todayKey())
  } catch (err) {
    warnBoardOnce(err instanceof Error ? err.message : 'falha', `${BASE}/home/fixtures/${todayKey()}/utc/mini`)
    return null
  }
}

export function setSokkerProFetchForTests(fn: typeof fetch | null): void {
  fetchFn = fn ?? globalThis.fetch.bind(globalThis)
}

export function setSokkerProNowForTests(date: Date | null): void {
  nowFn = date ? () => date : () => new Date()
}

export function resetSokkerProStateForTests(): void {
  boardCache.clear()
  oddsCache.clear()
  matchCache.clear()
  detailCache.clear()
  boardInflight.clear()
  boardFailLoggedThisTick = false
  nowFn = () => new Date()
  fetchFn = globalThis.fetch.bind(globalThis)
  liveScoreEnabled = SOKKERPRO_LIVE_SCORE
}

export function setSokkerProLiveScoreEnabledForTests(on: boolean | null): void {
  liveScoreEnabled = on ?? SOKKERPRO_LIVE_SCORE
}

/** Inject a flattened mini board (no HTTP) so notify-path tests stay in-memory. */
export function seedSokkerProBoardForTests(
  dateKey: string,
  fixtures: SokkerProFixture[],
): void {
  boardCache.set(dateKey, { ts: Date.now(), value: fixtures })
}

/**
 * Cache-only peek. Never starts a mini-board HTTP — notify must not wait
 * on the ~1 MB download. Slightly stale successful boards are OK.
 */
export function peekCachedSokkerProFixtures(): SokkerProFixture[] {
  const out: SokkerProFixture[] = []
  const seen = new Set<string>()
  for (const key of [todayKey(), yesterdayKey()]) {
    const hit = boardCache.get(key)
    if (!hit || !hit.value) continue
    if (Date.now() - hit.ts >= LIVE_SCORE_STALE_MS) continue
    for (const fixture of hit.value) {
      if (seen.has(fixture.fixtureId)) continue
      seen.add(fixture.fixtureId)
      out.push(fixture)
    }
  }
  return out
}

/**
 * SuperScore fixture → SokkerPro live score. In-memory match against the
 * warmed mini board. Missing board / name miss / disabled → `null` (fall through).
 */
export function getFastScore(
  fixture: Pick<Fixture, 'team1' | 'team2' | 'dateSeconds'>,
): FastScore | null {
  if (!isSokkerProLiveScoreEnabled()) return null
  return fastScoreFromBoard(peekCachedSokkerProFixtures(), fixture)
}

function todayKey(): string {
  return utcDateKey(nowFn())
}

function yesterdayKey(): string {
  return utcDateKeyDaysAgo(1, nowFn())
}

function warnBoardOnce(message: string, url: string): void {
  if (boardFailLoggedThisTick) return
  boardFailLoggedThisTick = true
  console.warn('[sokkerpro]', message, url)
}

async function fetchJson(
  url: string,
  timeoutMs: number,
  kind: 'board' | 'preodds',
): Promise<unknown | null> {
  try {
    const res = await fetchFn(url, {
      headers: {
        Accept: 'application/json',
        // m2 is Cloudflare-fronted; Origin/Referer of the public site is required.
        Origin: 'https://sokkerpro.com',
        Referer: 'https://sokkerpro.com/',
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) {
      if (kind === 'board') {
        warnBoardOnce(String(res.status), url)
      } else if (res.status !== 404) {
        console.warn('[sokkerpro]', res.status, url)
      }
      return null
    }
    return (await res.json()) as unknown
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'falha'
    if (kind === 'board') warnBoardOnce(msg, url)
    else console.warn('[sokkerpro]', msg, url)
    return null
  }
}

function cached<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
  ttlMs: number,
): T | undefined {
  const hit = map.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts >= ttlMs) return undefined
  return hit.value
}

function store<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): T {
  map.set(key, { ts: Date.now(), value })
  return value
}

function cachedBoard(dateKey: string): SokkerProFixture[] | null | undefined {
  const hit = boardCache.get(dateKey)
  if (!hit) return undefined
  // Failed fetches stay until beginSokkerProTick() so the same tick does not refetch.
  if (hit.value === null) return null
  if (Date.now() - hit.ts >= BOARD_CACHE_MS) return undefined
  return hit.value
}

async function loadBoardUncached(dateKey: string): Promise<SokkerProFixture[] | null> {
  const url = `${BASE}/home/fixtures/${dateKey}/utc/mini`
  const raw = await fetchJson(url, BOARD_TIMEOUT_MS, 'board')
  if (!raw) return store(boardCache, dateKey, null)
  try {
    return store(boardCache, dateKey, flattenMiniFixtures(raw))
  } catch (err) {
    warnBoardOnce(err instanceof Error ? err.message : 'board parse', url)
    return store(boardCache, dateKey, null)
  }
}

export async function fetchSokkerProBoard(dateKey: string): Promise<SokkerProFixture[] | null> {
  const hit = cachedBoard(dateKey)
  if (hit !== undefined) return hit
  const pending = boardInflight.get(dateKey)
  if (pending) return pending
  const request = loadBoardUncached(dateKey).finally(() => {
    boardInflight.delete(dateKey)
  })
  boardInflight.set(dateKey, request)
  return request
}

/**
 * Historical event clock. **Not** on the notify path — `/fixture/{id}` is a
 * second HTTP and the mini board already has the live score.
 * Mini has no timeline; this is the only public SokkerPro goal/corner minute list.
 */
export async function fetchSokkerProFixtureDetail(
  fixtureId: string,
): Promise<SokkerFixtureDetail | null> {
  const hit = cached(detailCache, fixtureId, DETAIL_CACHE_MS)
  if (hit !== undefined) return hit
  const raw = await fetchJson(`${BASE}/fixture/${encodeURIComponent(fixtureId)}`, DETAIL_TIMEOUT_MS, 'preodds')
  if (!raw) return store(detailCache, fixtureId, null)
  try {
    return store(detailCache, fixtureId, parseSokkerFixtureDetail(raw))
  } catch (err) {
    console.warn('[sokkerpro] fixture detail', err instanceof Error ? err.message : err)
    return store(detailCache, fixtureId, null)
  }
}

export async function fetchSokkerProPreodds(
  fixtureId: string,
): Promise<Record<string, string> | null> {
  const hit = cached(oddsCache, fixtureId, PREODDS_CACHE_MS)
  if (hit !== undefined) return hit
  const raw = await fetchJson(
    `${BASE}/fixture/${fixtureId}/preodds`,
    PREODDS_TIMEOUT_MS,
    'preodds',
  )
  if (!raw) return store(oddsCache, fixtureId, null)
  try {
    const map = collectOddsMap(raw)
    return store(oddsCache, fixtureId, Object.keys(map).length ? map : null)
  } catch (err) {
    console.warn('[sokkerpro] preodds parse', err instanceof Error ? err.message : err)
    return store(oddsCache, fixtureId, null)
  }
}

async function resolveSokkerProFixture(
  home: string,
  away: string,
): Promise<SokkerProFixture | null> {
  const today = await fetchSokkerProBoard(todayKey())
  // Today timed out / 404: do not pay a second board timeout for yesterday.
  if (today === null) return null
  const onToday = matchSokkerProFixture(today, home, away)
  if (onToday) return onToday
  const yesterday = await fetchSokkerProBoard(yesterdayKey())
  if (!yesterday) return null
  return matchSokkerProFixture(yesterday, home, away)
}

export async function loadSokkerProMatchOdds(
  home: string,
  away: string,
): Promise<SokkerProMatchOdds | null> {
  if (!isSokkerProOddsEnabled()) return null
  const key = `${home}|${away}`.toLowerCase()
  const hit = cached(matchCache, key, PREODDS_CACHE_MS)
  if (hit !== undefined) return hit
  try {
    const fixture = await resolveSokkerProFixture(home, away)
    if (!fixture) {
      // Name miss on a loaded board can be cached; a failed board must not poison the match.
      if (cachedBoard(todayKey()) === null) return null
      return store(matchCache, key, null)
    }
    const preodds = await fetchSokkerProPreodds(fixture.fixtureId)
    const odds = { ...fixture.odds, ...(preodds ?? {}) }
    if (!Object.keys(odds).length) return store(matchCache, key, { fixture, odds: {} })
    return store(matchCache, key, { fixture, odds })
  } catch (err) {
    console.warn('[sokkerpro] match odds', err instanceof Error ? err.message : err)
    return null
  }
}

export async function resolveSokkerProMaisUm(args: {
  home: string
  away: string
  market: Market
  half: CornerHalf
  currentTotal: number
}): Promise<SokkerProPick | null> {
  if (!isSokkerProOddsEnabled()) return null
  try {
    const bundle = await loadSokkerProMatchOdds(args.home, args.away)
    if (!bundle) return null
    return pickSokkerProMaisUm(
      bundle.odds,
      args.market,
      args.half,
      args.currentTotal,
      bundle.fixture.fixtureId,
    )
  } catch (err) {
    console.warn('[sokkerpro] quote', err instanceof Error ? err.message : err)
    return null
  }
}

export function pickFromSokkerProMatch(
  bundle: SokkerProMatchOdds | null,
  market: Market,
  half: CornerHalf,
  currentTotal: number,
): SokkerProPick | null {
  if (!bundle) return null
  try {
    return pickSokkerProMaisUm(
      bundle.odds,
      market,
      half,
      currentTotal,
      bundle.fixture.fixtureId,
    )
  } catch {
    return null
  }
}
