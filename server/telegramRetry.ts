import {
  TELEGRAM_RETRY_BASE_MS,
  TELEGRAM_RETRY_MAX_AGE_MS,
  TELEGRAM_RETRY_MAX_ATTEMPTS,
} from './config.ts'
import type { TelegramSendResult } from './telegram.ts'

/**
 * Bounded retry for live Telegram alerts.
 *
 * - Only transient failures are retried: network errors (`fetch failed`,
 *   DNS/connect/reset), HTTP 429 (waiting Telegram's `retry_after`) and 5xx.
 *   Other 4xx are final. Timeouts are NOT retried: after TELEGRAM_TIMEOUT_MS the
 *   request was fully sent and Telegram may have delivered it, so a retry
 *   risks a duplicate message.
 * - The first attempt stays inline (latency unchanged); retries run in the
 *   background so a slow/failing Bot API never blocks the tick.
 * - Lead gate: before every retry the caller re-checks the alert against the
 *   latest snapshot (same notifySuppressReason as the live path); and no
 *   attempt starts later than `maxAgeMs` after the first one.
 * - No duplicates: one retry chain per alert key (single-flight); the chain
 *   stops as soon as the alert is known delivered; the sent-key claim made
 *   before the first attempt still blocks re-claims on later ticks.
 */
export type TelegramRetryPolicy = {
  maxAttempts: number
  baseDelayMs: number
  maxAgeMs: number
}

export const DEFAULT_TELEGRAM_RETRY_POLICY: TelegramRetryPolicy = {
  maxAttempts: TELEGRAM_RETRY_MAX_ATTEMPTS,
  baseDelayMs: TELEGRAM_RETRY_BASE_MS,
  maxAgeMs: TELEGRAM_RETRY_MAX_AGE_MS,
}

export type RetryDecision =
  | { retry: true; delayMs: number }
  | { retry: false; reason: string }

/** Pure policy: may attempt number `attempts + 1` happen, and when? */
export function nextTelegramRetry(args: {
  attempts: number
  result: TelegramSendResult
  elapsedMs: number
  policy?: TelegramRetryPolicy
}): RetryDecision {
  const policy = args.policy ?? DEFAULT_TELEGRAM_RETRY_POLICY
  const { result, attempts, elapsedMs } = args
  if (result.sent > 0) return { retry: false, reason: 'entregue' }
  if (result.skipped) return { retry: false, reason: result.reason || 'ignorado' }
  if (!result.retryable) {
    return { retry: false, reason: `não transitório (${result.failureKind ?? 'erro'})` }
  }
  if (attempts >= policy.maxAttempts) {
    return { retry: false, reason: `esgotou ${policy.maxAttempts} tentativas` }
  }
  const backoff = policy.baseDelayMs * 3 ** Math.max(0, attempts - 1)
  const delayMs =
    result.retryAfterMs != null && result.retryAfterMs > 0 ? result.retryAfterMs : backoff
  if (elapsedMs + delayMs > policy.maxAgeMs) {
    return {
      retry: false,
      reason: `lead expirado (próxima tentativa aos ${Math.round((elapsedMs + delayMs) / 1000)}s > ${Math.round(policy.maxAgeMs / 1000)}s)`,
    }
  }
  return { retry: true, delayMs }
}

export type TelegramRetryJob = {
  key: string
  /** Wall-clock ms of the first (inline) attempt. */
  firstAttemptAt: number
  send: () => Promise<TelegramSendResult>
  /** Reason to drop instead of retrying (lead gate on the latest snapshot), else null. */
  dropReason: () => string | null
  onDelivered: (result: TelegramSendResult) => Promise<void> | void
}

export type TelegramRetryStats = {
  scheduled: number
  delivered: number
  dropped: number
  inFlight: number
  lastDropReason: string | null
}

const stats: TelegramRetryStats = {
  scheduled: 0,
  delivered: 0,
  dropped: 0,
  inFlight: 0,
  lastDropReason: null,
}
const chains = new Map<string, Promise<void>>()
let policy: TelegramRetryPolicy = DEFAULT_TELEGRAM_RETRY_POLICY
let sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))
let now = () => Date.now()

/** Clock used for the retry budget (injectable in tests). */
export function telegramRetryNow(): number {
  return now()
}

export function getTelegramRetryStats(): TelegramRetryStats {
  return { ...stats, inFlight: chains.size }
}

export function telegramRetryPending(key: string): boolean {
  return chains.has(key)
}

function drop(key: string, reason: string): void {
  stats.dropped += 1
  stats.lastDropReason = `${key}: ${reason}`
  console.warn('[telegram] retry abandonado', key, reason)
}

/**
 * Start a background retry chain after a failed first attempt.
 * Returns false (and does nothing) if the failure is not retryable, the
 * budget is already spent, or a chain for this key is already running.
 */
export function scheduleTelegramRetry(
  job: TelegramRetryJob,
  firstResult: TelegramSendResult,
): boolean {
  if (chains.has(job.key)) return false
  const first = nextTelegramRetry({
    attempts: 1,
    result: firstResult,
    elapsedMs: now() - job.firstAttemptAt,
    policy,
  })
  if (!first.retry) {
    if (firstResult.retryable) drop(job.key, first.reason)
    return false
  }
  stats.scheduled += 1
  const run = (async () => {
    let attempts = 1
    let decision: RetryDecision = first
    while (decision.retry) {
      await sleep(decision.delayMs)
      const gate = job.dropReason()
      if (gate) {
        drop(job.key, gate)
        return
      }
      attempts += 1
      let result: TelegramSendResult
      try {
        result = await job.send()
      } catch (err) {
        result = {
          sent: 0,
          skipped: false,
          reason: err instanceof Error ? err.message : String(err),
          retryable: false,
          failureKind: 'client',
        }
      }
      if (result.sent > 0) {
        stats.delivered += 1
        console.info('[telegram] retry entregue', job.key, `tentativa ${attempts}`)
        await job.onDelivered(result)
        return
      }
      decision = nextTelegramRetry({
        attempts,
        result,
        elapsedMs: now() - job.firstAttemptAt,
        policy,
      })
      if (!decision.retry) {
        drop(job.key, `${decision.reason}; último erro: ${result.reason || 'sem detalhe'}`)
        return
      }
    }
  })()
    .catch((err) => {
      console.warn('[telegram] retry', job.key, err instanceof Error ? err.message : err)
    })
    .finally(() => {
      chains.delete(job.key)
    })
  chains.set(job.key, run)
  return true
}

export async function waitForTelegramRetriesForTests(): Promise<void> {
  while (chains.size) {
    await Promise.all([...chains.values()])
  }
}

export function setTelegramRetryForTests(opts: {
  policy?: Partial<TelegramRetryPolicy>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
} | null): void {
  policy = { ...DEFAULT_TELEGRAM_RETRY_POLICY, ...(opts?.policy ?? {}) }
  sleep = opts?.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  now = opts?.now ?? (() => Date.now())
}

export function resetTelegramRetryForTests(): void {
  chains.clear()
  stats.scheduled = 0
  stats.delivered = 0
  stats.dropped = 0
  stats.inFlight = 0
  stats.lastDropReason = null
  setTelegramRetryForTests(null)
}
