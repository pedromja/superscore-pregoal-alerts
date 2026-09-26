import type { FeedAlert, Market } from './types'

const KEYS: Record<Market, { feed: string; seen: string; primed: string }> = {
  goals: {
    feed: 'superscore.pregoal.feed.v1',
    seen: 'superscore.pregoal.seen.v1',
    primed: 'superscore.pregoal.primed.v1',
  },
  corners: {
    feed: 'superscore.pregoal.feed.corners.v1',
    seen: 'superscore.pregoal.seen.corners.v1',
    primed: 'superscore.pregoal.primed.corners.v1',
  },
}

function readList(key: string): string[] {
  try {
    const raw = sessionStorage.getItem(key)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function loadSeen(market: Market = 'goals'): Set<string> {
  return new Set(readList(KEYS[market].seen))
}

export function saveSeen(seen: Set<string>, market: Market = 'goals'): void {
  sessionStorage.setItem(KEYS[market].seen, JSON.stringify([...seen]))
}

export function loadPrimed(market: Market = 'goals'): Set<string> {
  return new Set(readList(KEYS[market].primed))
}

export function savePrimed(primed: Set<string>, market: Market = 'goals'): void {
  sessionStorage.setItem(KEYS[market].primed, JSON.stringify([...primed]))
}

export function loadFeed(market: Market = 'goals'): FeedAlert[] {
  try {
    const raw = sessionStorage.getItem(KEYS[market].feed)
    if (!raw) return []
    const parsed = JSON.parse(raw) as FeedAlert[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveFeed(feed: FeedAlert[], market: Market = 'goals'): void {
  sessionStorage.setItem(KEYS[market].feed, JSON.stringify(feed.slice(0, 80)))
}
