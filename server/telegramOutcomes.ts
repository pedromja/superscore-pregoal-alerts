import { isBetDecided } from '../src/lib/betOutcome.ts'
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
  upsertTelegramMessage,
} from './store.ts'
import {
  formatTelegramOutcomeHtml,
  sendTelegramOutcomeNotice,
} from './telegram.ts'
import { formatTelegramResultLine } from './telegramCompose.ts'
import {
  alertEditSucceeded,
  inlineEditsActive,
  requestTelegramAlertEdit,
  telegramRecordEditable,
} from './telegramEdits.ts'
import type { LoggedAlert } from './types.ts'

const pending = new Set<string>()
/** Live GREEN/RED only for alerts sent within this window. */
const OUTCOME_NOTICE_MAX_AGE_MS = 12 * 60 * 60_000
let flushScheduled = false
let flushTail = Promise.resolve()

/**
 * The Telegram GREEN/RED follows the bet outcome (end of the half, see
 * src/lib/betOutcome.ts), not the learning labels (hit5/hitLong).
 */
export function alertOutcomeSettled(alert: Pick<LoggedAlert, 'betOutcome'>): boolean {
  return isBetDecided(alert.betOutcome)
}

export function alertOutcomeNewlySettled(
  prev: Pick<LoggedAlert, 'betOutcome'> | undefined,
  next: Pick<LoggedAlert, 'betOutcome'>,
): boolean {
  if (!alertOutcomeSettled(next)) return false
  if (!prev) return true
  return !alertOutcomeSettled(prev)
}

export function enqueueTelegramOutcome(alertKey: string): void {
  pending.add(alertKey)
}

export function enqueueSettledTelegramOutcomes(alerts: LoggedAlert[]): string[] {
  const keys: string[] = []
  for (const alert of alerts) {
    if (!alertOutcomeSettled(alert)) continue
    // VOID alerts never get a GREEN/RED (not counted, not announced).
    if (alert.void) continue
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

/**
 * Inline path: append the GREEN/RED line to the original alert (edit, keyboard
 * removed). Returns false when the edit did not land so the caller falls back
 * to the legacy reply once (no retry loop).
 */
async function editOutcomeInline(alertKey: string, alert: LoggedAlert): Promise<boolean> {
  upsertTelegramMessage(alertKey, { resultLine: formatTelegramResultLine(alert) })
  const outcome = await requestTelegramAlertEdit(alertKey, 'resultado')
  if (alertEditSucceeded(outcome)) return true
  console.warn(
    '[telegram] resultado inline falhou — a responder com mensagem',
    alertKey,
    outcome.reason || outcome.kind,
  )
  return false
}

async function sendOutcomeForKey(alertKey: string): Promise<void> {
  if (!telegramEnabled()) return
  if (telegramOutcomeAlreadySent(alertKey)) return

  const found = findLoggedAlert(alertKey)
  if (!found || !alertOutcomeSettled(found.alert)) return
  if (found.alert.void) return
  // Old alerts (re-settled from stored data) are corrected by the rate-limited
  // re-settle edits, never by live notices/replies.
  const sentAt = Date.parse(found.alert.telegramSentAt ?? found.alert.ts)
  if (Number.isFinite(sentAt) && Date.now() - sentAt > OUTCOME_NOTICE_MAX_AGE_MS) return

  const rec = getTelegramMessage(alertKey)
  const messageId = found.alert.telegramMessageId ?? rec?.messageId
  if (!wasNotified(found.alert, messageId && messageId > 0 ? messageId : undefined)) {
    return
  }

  if (!claimTelegramOutcome(alertKey)) return

  const inline = inlineEditsActive() && telegramRecordEditable(rec)
  if (inline && (await editOutcomeInline(alertKey, found.alert))) return

  // Legacy path (alerts without an editable message, inline edits off, or a
  // failed edit): reply to the alert. After a failed inline edit we do not try
  // a second edit inside the legacy notice.
  const text = formatTelegramOutcomeHtml(found.alert)
  const replyTo = messageId && messageId > 0 ? messageId : undefined
  const result = await sendTelegramOutcomeNotice({
    alertKey,
    text,
    replyToMessageId: replyTo,
    originalText: inline ? undefined : rec?.text,
  })

  if (result.skipped || result.sent < 1) {
    clearTelegramOutcomeClaim(alertKey)
    if (inline) upsertTelegramMessage(alertKey, { resultLine: null })
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
