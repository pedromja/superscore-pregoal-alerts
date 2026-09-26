import type { CornerHalf, Market } from '../src/lib/types.ts'
import {
  parseOddsApiModel,
  pickAsianSnapshot,
  pickLimitSnapshot,
  pickMaisUmOdd,
  type LiveOddPick,
  type SuperbetEvent,
} from '../src/lib/oddsMarkets.ts'
import { POLLER_REGION } from './config.ts'

const SUPERBET_BY_REGION: Record<string, { host: string; locale: string }> = {
  ro: {
    host: 'https://production-superbet-offer-ro.freetls.fastly.net',
    locale: 'ro-RO',
  },
  pl: {
    host: 'https://production-superbet-offer-pl.freetls.fastly.net',
    locale: 'pl-PL',
  },
  br: {
    host: 'https://production-superbet-offer-br.freetls.fastly.net',
    locale: 'pt-BR',
  },
}

const SS_OFFER = 'https://api.content-prod.superscore.live'

type CacheEntry = { ts: number; event: SuperbetEvent | null; eventId: number | null }
const cache = new Map<string, CacheEntry>()
const CACHE_MS = 25_000

function superbetConfig(region = POLLER_REGION): { host: string; locale: string } {
  return SUPERBET_BY_REGION[region] ?? SUPERBET_BY_REGION.ro
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(8000),
    })
    if (!res.ok) return null
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

export async function fetchSuperScoreEventId(
  fixtureId: string,
  known?: number | null,
): Promise<number | null> {
  if (known && known > 0) return known
  const params = new URLSearchParams({
    match_id: fixtureId,
    app_market: POLLER_REGION || 'ro',
    app_variant: 'superscore',
  })
  const raw = await fetchJson(`${SS_OFFER}/v2/public/stats/offer/market/item?${params}`)
  const parsed = parseOddsApiModel(raw)
  return parsed.eventId
}

export async function fetchSuperbetEvent(
  eventId: number,
  region = POLLER_REGION,
): Promise<SuperbetEvent | null> {
  const { host, locale } = superbetConfig(region)
  const url = `${host}/v3/${locale}/events?events=${eventId}&includeOnly=fixture,markets,superbets`
  const raw = await fetchJson(url)
  if (!raw || typeof raw !== 'object') return null
  const events = (raw as { events?: SuperbetEvent[] }).events
  return events?.find((e) => e.event_id === eventId) ?? events?.[0] ?? null
}

export async function loadSuperbetEvent(
  fixtureId: string,
  known?: number | null,
): Promise<SuperbetEvent | null> {
  const cached = cache.get(fixtureId)
  if (cached && Date.now() - cached.ts < CACHE_MS) return cached.event
  const eventId = await fetchSuperScoreEventId(fixtureId, known ?? cached?.eventId)
  const event = eventId ? await fetchSuperbetEvent(eventId) : null
  cache.set(fixtureId, { ts: Date.now(), event, eventId })
  return event
}

export async function resolveSuperScoreMaisUm(args: {
  fixtureId: string
  eventId?: number | null
  market: Market
  half: CornerHalf
  currentTotal: number
}): Promise<LiveOddPick | null> {
  const event = await loadSuperbetEvent(args.fixtureId, args.eventId)
  if (!event) return null
  return pickMaisUmOdd(event, args.market, args.half, args.currentTotal)
}

export function snapshotsFromEvent(
  event: SuperbetEvent | null,
  market: Market,
  half: CornerHalf,
  currentTotal: number,
): { limit: ReturnType<typeof pickLimitSnapshot>; asian: ReturnType<typeof pickAsianSnapshot> } {
  return {
    limit: pickLimitSnapshot(event, market, half, currentTotal),
    asian: pickAsianSnapshot(event, market, half),
  }
}
