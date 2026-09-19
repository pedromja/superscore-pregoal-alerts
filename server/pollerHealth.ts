import type { Fixture, Market } from '../src/lib/types.ts'
import {
  inAnyActiveMarketWindow,
  inCornerWindow,
  inGoalsWindow,
} from '../src/lib/windows.ts'

/** Defaults match Railway production (env still wins). */
export const POLLER_INTERVAL_MS_DEFAULT = 15_000
export const POLLER_LIVE_LIMIT_DEFAULT = 32
export const POLLER_FINISHED_LIMIT_DEFAULT = 6
export const POLLER_CONCURRENCY_DEFAULT = 8
/** In-window live fixtures get a larger worker pool than the rotating fill. */
export const POLLER_IN_WINDOW_CONCURRENCY_DEFAULT = 12
export const POLLER_FIXTURE_TIMEOUT_MS_DEFAULT = 12_000
export const POLLER_TICK_WATCHDOG_MS_DEFAULT = 80_000
export const POLLER_JSON_BACKOFF_MAX_MS_DEFAULT = 10 * 60 * 1000
export const WINDOW_PRIORITY = 1000

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TimeoutError'
  }
}

export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(message)), ms)
  })
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!items.length) return []
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Math.max(1, Math.min(limit, items.length))
  async function worker(): Promise<void> {
    while (true) {
      const i = next
      next += 1
      if (i >= items.length) return
      results[i] = await fn(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: workers }, () => worker()))
  return results
}

export function rotateSlice<T>(items: T[], offset: number, count: number): T[] {
  if (!items.length || count <= 0) return []
  const n = Math.min(count, items.length)
  const start = ((offset % items.length) + items.length) % items.length
  const out: T[] = []
  for (let i = 0; i < n; i += 1) {
    out.push(items[(start + i) % items.length])
  }
  return out
}

/** Absolute SuperScore clock from live elapsed seconds. */
export function clockFromElapsed(
  elapsedSeconds: number | null | undefined,
): { min: number; period: 1 | 2 } | null {
  if (elapsedSeconds == null || !Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
    return null
  }
  const min = Math.floor(elapsedSeconds / 60)
  if (min <= 0) return { min: 0, period: 1 }
  const period: 1 | 2 = min <= 45 ? 1 : 2
  return { min, period }
}

export function approachingCornerWindow(min: number, period: number): boolean {
  if (period === 1 && min >= 28 && min < 32) return true
  if (period === 2 && min >= 78 && min < 82) return true
  return false
}

export function fixtureInAnyMarketWindow(fixture: Fixture): boolean {
  const clock = clockFromElapsed(fixture.liveElapsedSeconds)
  if (!clock) return false
  return inAnyActiveMarketWindow(clock.min, clock.period)
}

export function fixturePriorityScore(
  fixture: Fixture,
  market: Market,
  now: number,
  lastOkAt: Map<string, number>,
): number {
  const clock = clockFromElapsed(fixture.liveElapsedSeconds)
  let score = 0
  if (clock) {
    if (inAnyActiveMarketWindow(clock.min, clock.period)) {
      score += WINDOW_PRIORITY
      // Late FT corner (82–87) is the narrowest window — scan first.
      if (inCornerWindow(clock.min, clock.period) && clock.period === 2) score += 200
      else if (inGoalsWindow(clock.min, clock.period) && clock.period === 2) score += 150
      else if (inCornerWindow(clock.min, clock.period)) score += 80
      else score += 50
    } else if (market === 'corners' && approachingCornerWindow(clock.min, clock.period)) {
      score += 400
    }
  }
  const lastOk = lastOkAt.get(fixture.id)
  if (lastOk == null) score += 20
  else if (now - lastOk < 3 * 60 * 1000) score += 50
  return score
}

export type LiveTargetSelection = {
  inWindow: Fixture[]
  fill: Fixture[]
}

/**
 * Every in-window live fixture is kept (goals and/or corners for that minute).
 * LIVE_LIMIT only caps the rotating out-of-window fill.
 */
export function selectLiveTargets(args: {
  live: Fixture[]
  market: Market
  limit: number
  now: number
  tickIndex: number
  lastOkAt: Map<string, number>
  isBackedOff: (id: string) => boolean
}): LiveTargetSelection {
  const { live, market, limit, now, tickIndex, lastOkAt, isBackedOff } = args
  const eligible = live.filter((f) => !isBackedOff(f.id))
  const ranked = eligible
    .map((fixture) => ({
      fixture,
      score: fixturePriorityScore(fixture, market, now, lastOkAt),
    }))
    .sort((a, b) => b.score - a.score || a.fixture.id.localeCompare(b.fixture.id))

  const inWindow = ranked
    .filter((row) => fixtureInAnyMarketWindow(row.fixture))
    .map((row) => row.fixture)
  const rest = ranked
    .filter((row) => !fixtureInAnyMarketWindow(row.fixture))
    .map((row) => row.fixture)
  const fillSlots = limit > inWindow.length ? limit - inWindow.length : 0
  const fill = rotateSlice(rest, tickIndex * Math.max(fillSlots, 1), fillSlots)
  return { inWindow, fill }
}

export function flattenLiveTargets(selection: LiveTargetSelection): Fixture[] {
  return [...selection.inWindow, ...selection.fill]
}

export class JsonBackoff {
  private readonly items = new Map<string, { fails: number; until: number }>()

  constructor(
    private readonly intervalMs: number,
    private readonly maxMs: number,
    private readonly failBeforeSkip = 2,
  ) {}

  noteSuccess(id: string): void {
    this.items.delete(id)
  }

  noteFailure(id: string, now: number): void {
    const fails = (this.items.get(id)?.fails ?? 0) + 1
    if (fails < this.failBeforeSkip) {
      this.items.set(id, { fails, until: 0 })
      return
    }
    const exp = fails - this.failBeforeSkip
    const skipMs = Math.min(this.intervalMs * 2 ** exp, this.maxMs)
    this.items.set(id, { fails, until: now + skipMs })
  }

  isBlocked(id: string, now: number): boolean {
    const entry = this.items.get(id)
    return Boolean(entry && entry.until > now)
  }

  peek(id: string): { fails: number; until: number } | undefined {
    return this.items.get(id)
  }

  blockedCount(now: number): number {
    let n = 0
    for (const entry of this.items.values()) {
      if (entry.until > now) n += 1
    }
    return n
  }

  prune(keep: Set<string>): void {
    for (const id of [...this.items.keys()]) {
      if (!keep.has(id)) this.items.delete(id)
    }
  }

  reset(): void {
    this.items.clear()
  }
}

export function combinedAbortSignal(
  timeoutMs: number,
  extra?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!extra) return timeout
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([timeout, extra])
  }
  const ctrl = new AbortController()
  const abort = () => {
    if (!ctrl.signal.aborted) ctrl.abort()
  }
  if (timeout.aborted || extra.aborted) {
    abort()
    return ctrl.signal
  }
  timeout.addEventListener('abort', abort, { once: true })
  extra.addEventListener('abort', abort, { once: true })
  return ctrl.signal
}
