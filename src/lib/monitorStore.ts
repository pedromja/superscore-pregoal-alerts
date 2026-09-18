import type { FeedAlert } from './types'

const FEED_KEY = 'superscore.pregoal.feed.v1'
const SEEN_KEY = 'superscore.pregoal.seen.v1'
const PRIMED_KEY = 'superscore.pregoal.primed.v1'

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

export function loadSeen(): Set<string> {
  return new Set(readList(SEEN_KEY))
}

export function saveSeen(seen: Set<string>): void {
  sessionStorage.setItem(SEEN_KEY, JSON.stringify([...seen]))
}

export function loadPrimed(): Set<string> {
  return new Set(readList(PRIMED_KEY))
}

export function savePrimed(primed: Set<string>): void {
  sessionStorage.setItem(PRIMED_KEY, JSON.stringify([...primed]))
}

export function loadFeed(): FeedAlert[] {
  try {
    const raw = sessionStorage.getItem(FEED_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as FeedAlert[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

export function saveFeed(feed: FeedAlert[]): void {
  sessionStorage.setItem(FEED_KEY, JSON.stringify(feed.slice(0, 80)))
}
