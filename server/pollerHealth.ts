import type { Fixture, Market } from '../src/lib/types.ts'
import { inCornerWindow } from '../src/lib/windows.ts'

export const POLLER_LIVE_LIMIT_DEFAULT = 24
export const POLLER_FINISHED_LIMIT_DEFAULT = 6
export const POLLER_CONCURRENCY_DEFAULT = 5
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

export function fixturePriorityScore(
  fixture: Fixture,
  market: Market,
  now: number,
  lastOkAt: Map<string, number>,
): number {
  const clock = clockFromElapsed(fixture.liveElapsedSeconds)
  let score = 0
  if (clock) {
    if (market === 'corners') {
      if (inCornerWindow(clock.min, clock.period)) score += WINDOW_PRIORITY
      else if (approachingCornerWindow(clock.min, clock.period)) score += 400
    } else {
      if (clock.period === 2 && clock.min >= 80) score += 900
      else if (clock.period === 2 && clock.min >= 70) score += 700
      else if (clock.period === 1 && clock.min >= 35) score += 600
    }
  }
  const lastOk = lastOkAt.get(fixture.id)
  if (lastOk == null) score += 20
  else if (now - lastOk < 3 * 60 * 1000) score += 50
  return score
}

export function selectLiveTargets(args: {
  live: Fixture[]
  market: Market
  limit: number
  now: number
  tickIndex: number
  lastOkAt: Map<string, number>
  isBackedOff: (id: string) => boolean
}): Fixture[] {
  const { live, market, limit, now, tickIndex, lastOkAt, isBackedOff } = args
  if (limit <= 0) return []
  const eligible = live.filter((f) => !isBackedOff(f.id))
  const ranked = eligible
    .map((fixture) => ({
      fixture,
      score: fixturePriorityScore(fixture, market, now, lastOkAt),
    }))
    .sort((a, b) => b.score - a.score || a.fixture.id.localeCompare(b.fixture.id))

  const priority = ranked.filter((row) => row.score >= WINDOW_PRIORITY).map((row) => row.fixture)
  const rest = ranked.filter((row) => row.score < WINDOW_PRIORITY).map((row) => row.fixture)
  if (priority.length >= limit) return priority.slice(0, limit)
  const fill = rotateSlice(rest, tickIndex * (limit - priority.length), limit - priority.length)
  return [...priority, ...fill]
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
