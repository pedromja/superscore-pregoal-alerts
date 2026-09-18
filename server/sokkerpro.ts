import {
  collectOddsMap,
  flattenMiniFixtures,
  matchSokkerProFixture,
  pickSokkerProMaisUm,
  utcDateKey,
  utcDateKeyDaysAgo,
  type SokkerProFixture,
  type SokkerProPick,
  SOKKERPRO_CACHE_MS,
} from '../src/lib/sokkerpro.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { SOKKERPRO_ODDS } from './config.ts'

const BASE = (process.env.SOKKERPRO_M2_URL || 'https://m2.sokkerpro.com').replace(/\/$/, '')
const TIMEOUT_MS = Number(process.env.SOKKERPRO_TIMEOUT_MS || 6000)

type CacheEntry<T> = { ts: number; value: T }
const boardCache = new Map<string, CacheEntry<SokkerProFixture[] | null>>()
const oddsCache = new Map<string, CacheEntry<Record<string, string> | null>>()
const matchCache = new Map<string, CacheEntry<SokkerProMatchOdds | null>>()

export type SokkerProMatchOdds = {
  fixture: SokkerProFixture
  odds: Record<string, string>
}

export function isSokkerProOddsEnabled(): boolean {
  return SOKKERPRO_ODDS
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: {
        Accept: 'application/json',
        // m2 is Cloudflare-fronted; Origin/Referer of the public site is required.
        Origin: 'https://sokkerpro.com',
        Referer: 'https://sokkerpro.com/',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) {
      if (res.status !== 404) {
        console.warn('[sokkerpro]', res.status, url)
      }
      return null
    }
    return (await res.json()) as unknown
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'falha'
    console.warn('[sokkerpro]', msg, url)
    return null
  }
}

function cached<T>(
  map: Map<string, CacheEntry<T>>,
  key: string,
): T | undefined {
  const hit = map.get(key)
  if (!hit) return undefined
  if (Date.now() - hit.ts >= SOKKERPRO_CACHE_MS) return undefined
  return hit.value
}

function store<T>(map: Map<string, CacheEntry<T>>, key: string, value: T): T {
  map.set(key, { ts: Date.now(), value })
  return value
}

export async function fetchSokkerProBoard(dateKey: string): Promise<SokkerProFixture[] | null> {
  const hit = cached(boardCache, dateKey)
  if (hit !== undefined) return hit
  const raw = await fetchJson(`${BASE}/home/fixtures/${dateKey}/utc/mini`)
  if (!raw) return store(boardCache, dateKey, null)
  try {
    return store(boardCache, dateKey, flattenMiniFixtures(raw))
  } catch (err) {
    console.warn('[sokkerpro] board parse', err instanceof Error ? err.message : err)
    return store(boardCache, dateKey, null)
  }
}

export async function fetchSokkerProPreodds(
  fixtureId: string,
): Promise<Record<string, string> | null> {
  const hit = cached(oddsCache, fixtureId)
  if (hit !== undefined) return hit
  const raw = await fetchJson(`${BASE}/fixture/${fixtureId}/preodds`)
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
  const dates = [utcDateKey(), utcDateKeyDaysAgo(1)]
  for (const dateKey of dates) {
    const board = await fetchSokkerProBoard(dateKey)
    if (!board?.length) continue
    const fixture = matchSokkerProFixture(board, home, away)
    if (fixture) return fixture
  }
  return null
}

export async function loadSokkerProMatchOdds(
  home: string,
  away: string,
): Promise<SokkerProMatchOdds | null> {
  if (!isSokkerProOddsEnabled()) return null
  const key = `${home}|${away}`.toLowerCase()
  const hit = cached(matchCache, key)
  if (hit !== undefined) return hit
  try {
    const fixture = await resolveSokkerProFixture(home, away)
    if (!fixture) return store(matchCache, key, null)
    const preodds = await fetchSokkerProPreodds(fixture.fixtureId)
    const odds = { ...fixture.odds, ...(preodds ?? {}) }
    if (!Object.keys(odds).length) return store(matchCache, key, { fixture, odds: {} })
    return store(matchCache, key, { fixture, odds })
  } catch (err) {
    console.warn('[sokkerpro] match odds', err instanceof Error ? err.message : err)
    return store(matchCache, key, null)
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
