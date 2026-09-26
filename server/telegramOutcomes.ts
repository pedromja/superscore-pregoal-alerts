import type { CornerHalf, Market } from '../src/lib/types.ts'
import { loggedAlertKey } from './alertKeys.ts'
import { telegramEnabled } from './config.ts'
import {
  claimTelegramOutcome,
  clearTelegramOutcomeClaim,
  findLoggedAlert,
  getTelegramMessage,
  loadAlerts,
  telegramOutcomeAlreadySent,
} from './store.ts'
import {
  formatTelegramOutcomeHtml,
  sendTelegramOutcomeNotice,
} from './telegram.ts'
import type { LoggedAlert } from './types.ts'

const pending = new Set<string>()
let flushScheduled = false
let flushTail = Promise.resolve()

export function alertOutcomeSettled(alert: Pick<LoggedAlert, 'hit5' | 'hitLong'>): boolean {
  return alert.hit5 !== null || alert.hitLong !== null
}

export function alertOutcomeNewlySettled(
  prev: Pick<LoggedAlert, 'hit5' | 'hitLong'> | undefined,
  next: Pick<LoggedAlert, 'hit5' | 'hitLong'>,
): boolean {
  if (!alertOutcomeSettled(next)) return false
  if (!prev) return true
  return prev.hit5 === null && prev.hitLong === null
}

export function enqueueTelegramOutcome(alertKey: string): void {
  pending.add(alertKey)
}

export function enqueueSettledTelegramOutcomes(alerts: LoggedAlert[]): string[] {
  const keys: string[] = []
  for (const alert of alerts) {
    if (!alertOutcomeSettled(alert)) continue
    // Market-qualified: a goals and a corners alert may share `alert.id`.
    const key = loggedAlertKey(alert)
    if (telegramOutcomeAlreadySent(key)) continue
    enqueueTelegramOutcome(key)
    keys.push(key)
  }
  return keys
}

export function enqueueScopeTelegramOutcomes(
  market: Market,
  half?: CornerHalf | null,
): string[] {
  return enqueueSettledTelegramOutcomes(loadAlerts(market, half))
}

export function scheduleTelegramOutcomeFlush(): void {
  if (flushScheduled) return
  flushScheduled = true
  const run = async () => {
    flushScheduled = false
    const keys = [...pending]
    pending.clear()
    for (const key of keys) {
      try {
        await sendOutcomeForKey(key)
      } catch (err) {
        console.warn(
          '[telegram] outcome',
          key,
          err instanceof Error ? err.message : err,
        )
      }
    }
    if (pending.size) scheduleTelegramOutcomeFlush()
  }
  flushTail = flushTail.then(run, run)
  setImmediate(() => {
    void flushTail
  })
}

export function enqueueAndFlushTelegramOutcomes(alerts: LoggedAlert[]): void {
  enqueueSettledTelegramOutcomes(alerts)
  scheduleTelegramOutcomeFlush()
}

function wasNotified(alert: LoggedAlert, messageId?: number): boolean {
  return Boolean(alert.sentPush || alert.telegramMessageId || messageId)
}

async function sendOutcomeForKey(alertKey: string): Promise<void> {
  if (!telegramEnabled()) return
  if (telegramOutcomeAlreadySent(alertKey)) return

  const found = findLoggedAlert(alertKey)
  if (!found || !alertOutcomeSettled(found.alert)) return

  const rec = getTelegramMessage(alertKey)
  const messageId = found.alert.telegramMessageId ?? rec?.messageId
  if (!wasNotified(found.alert, messageId && messageId > 0 ? messageId : undefined)) {
    return
  }

  if (!claimTelegramOutcome(alertKey)) return

  const text = formatTelegramOutcomeHtml(found.alert)
  const replyTo = messageId && messageId > 0 ? messageId : undefined
  const result = await sendTelegramOutcomeNotice({
    alertKey,
    text,
    replyToMessageId: replyTo,
    originalText: rec?.text,
  })

  if (result.skipped || result.sent < 1) {
    clearTelegramOutcomeClaim(alertKey)
    if (!result.skipped) {
      console.warn(
        '[telegram] outcome não enviado',
        alertKey,
        result.reason || 'sem detalhe',
      )
    }
  }
}

export async function waitForTelegramOutcomesForTests(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await flushTail
    if (!pending.size && !flushScheduled) break
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
  }
  await flushTail
}

export function resetTelegramOutcomesForTests(): void {
  pending.clear()
  flushScheduled = false
  flushTail = Promise.resolve()
}

export function pendingTelegramOutcomeCountForTests(): number {
  return pending.size
}
