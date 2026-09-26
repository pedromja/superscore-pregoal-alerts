/**
 * Inline edits of live Telegram alerts (odds line, VOID, GREEN/RED).
 *
 * - One serial chain per alert key: edits for the same message never overlap.
 * - Every edit rebuilds the whole text from state (base text stored at send +
 *   odds line + VOID/result line) via telegramCompose, so an odds edit landing
 *   after the result, or VOID after odds, never drops the other line.
 * - Identical text + keyboard state → no API call. "message is not modified"
 *   counts as success. Failures are logged and recorded on the record; there
 *   is no retry loop here.
 */
import type { FeedAlert, Market } from '../src/lib/types.ts'
import { alertKeyFor } from './alertKeys.ts'
import { telegramEnabled, telegramInlineEditsEnabled, telegramOddsEditMaxMs } from './config.ts'
import {
  findLoggedAlert,
  getTelegramMessage,
  loadTelegramMessages,
  upsertTelegramMessage,
  type TelegramMessageRecord,
} from './store.ts'
import { editTelegramMessage, resolveNowKeyboard } from './telegram.ts'
import {
  composedMessageIsFinal,
  composeTelegramAlertText,
  formatTelegramOddsLine,
  formatTelegramVoidLine,
  type AlertMessageState,
} from './telegramCompose.ts'

export type AlertEditKind =
  | 'edited'
  | 'not-modified'
  | 'unchanged'
  | 'no-message'
  | 'disabled'
  | 'failed'

export type AlertEditOutcome = {
  kind: AlertEditKind
  reason?: string
  text?: string
}

export function alertEditSucceeded(outcome: AlertEditOutcome): boolean {
  return outcome.kind === 'edited' || outcome.kind === 'not-modified' || outcome.kind === 'unchanged'
}

/** Telegram on and TELEGRAM_INLINE_EDITS not switched off. */
export function inlineEditsActive(): boolean {
  return telegramEnabled() && telegramInlineEditsEnabled()
}

/** A record we can edit: known message_id and the base HTML we sent. */
export function telegramRecordEditable(
  rec: TelegramMessageRecord | null | undefined,
): rec is TelegramMessageRecord {
  return Boolean(rec && rec.messageId > 0 && rec.text)
}

export function alertMessageState(
  alertKey: string,
): { rec: TelegramMessageRecord; state: AlertMessageState } | null {
  const rec = getTelegramMessage(alertKey)
  if (!telegramRecordEditable(rec)) return null
  const alert = findLoggedAlert(alertKey)?.alert
  const voidLine = alert?.void
    ? formatTelegramVoidLine({ market: alert.market, event: alert.voidCheck?.event ?? null })
    : null
  return {
    rec,
    state: {
      baseText: rec.text,
      oddsLine: rec.oddsLine ?? null,
      voidLine,
      resultLine: rec.resultLine ?? null,
    },
  }
}

async function runEdit(alertKey: string, why: string): Promise<AlertEditOutcome> {
  try {
    if (!inlineEditsActive()) return { kind: 'disabled' }
    const snap = alertMessageState(alertKey)
    if (!snap) return { kind: 'no-message' }
    const text = composeTelegramAlertText(snap.state)
    const final = composedMessageIsFinal(snap.state)
    const shown = snap.rec.lastEditText ?? snap.rec.text
    if (text === shown && final === Boolean(snap.rec.finalized)) {
      return { kind: 'unchanged', text }
    }
    const res = await editTelegramMessage({
      alertKey,
      chatId: snap.rec.chatId,
      messageId: snap.rec.messageId,
      text,
      // Final status (VOID / GREEN / RED) removes "Resolver agora".
      replyMarkup: final ? { inline_keyboard: [] } : resolveNowKeyboard(alertKey),
    })
    if (res.ok) {
      upsertTelegramMessage(alertKey, {
        lastEditText: text,
        finalized: final,
        editedAt: new Date().toISOString(),
        lastEditError: null,
      })
      return { kind: res.notModified ? 'not-modified' : 'edited', text }
    }
    if (res.skipped) return { kind: 'disabled', reason: res.reason }
    upsertTelegramMessage(alertKey, { lastEditError: `${why}: ${res.reason ?? 'erro'}` })
    return { kind: 'failed', reason: res.reason }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    console.warn('[telegram] edit', alertKey, why, reason)
    return { kind: 'failed', reason }
  }
}

const chains = new Map<string, Promise<AlertEditOutcome>>()

/** Queue an edit of the alert's message; resolves when this edit ran. Never rejects. */
export function requestTelegramAlertEdit(
  alertKey: string,
  why = 'edit',
): Promise<AlertEditOutcome> {
  const prev = chains.get(alertKey) ?? Promise.resolve<AlertEditOutcome>({ kind: 'unchanged' })
  const run = prev.then(
    () => runEdit(alertKey, why),
    () => runEdit(alertKey, why),
  )
  chains.set(alertKey, run)
  void run.then(() => {
    if (chains.get(alertKey) === run) chains.delete(alertKey)
  })
  return run
}

/**
 * Delivered alerts still waiting for their odds line (in memory: the poller
 * attaches odds for every alert of every in-window fixture each tick, so this
 * keeps noteTelegramOdds from reading telegram_messages.json on every tick).
 * Lost on restart — the window is only TELEGRAM_ODDS_EDIT_MAX_MS anyway.
 */
const awaitingOdds = new Map<string, number>()

export function trackTelegramOddsPending(alertKey: string, sentAtMs = Date.now()): void {
  if (!inlineEditsActive()) return
  awaitingOdds.set(alertKey, sentAtMs)
}

/**
 * attachOdds finished for these alerts (SuperScore → SokkerPro → RoboBet):
 * append the odds line to delivered alerts that don't have one yet. The line
 * is captured once (the first price seen within TELEGRAM_ODDS_EDIT_MAX_MS of
 * the send) and never changes afterwards. Past the window with nothing found
 * the message stays without an odds line. Never blocks: edits are queued.
 */
export function noteTelegramOdds(
  market: Market,
  fixtureId: string,
  alerts: Pick<FeedAlert, 'id' | 'odds'>[],
  now = Date.now(),
): string[] {
  if (!awaitingOdds.size || !alerts.length) return []
  const maxMs = telegramOddsEditMaxMs()
  for (const [key, sentMs] of awaitingOdds) {
    if (now - sentMs > maxMs) awaitingOdds.delete(key)
  }
  if (!inlineEditsActive()) return []
  const candidates = alerts.filter((alert) =>
    awaitingOdds.has(alertKeyFor(market, fixtureId, alert.id)),
  )
  if (!candidates.length) return []
  const map = loadTelegramMessages()
  const queued: string[] = []
  for (const alert of candidates) {
    const key = alertKeyFor(market, fixtureId, alert.id)
    const rec = map[key]
    if (!telegramRecordEditable(rec) || rec.oddsLine !== undefined) {
      awaitingOdds.delete(key)
      continue
    }
    const line = formatTelegramOddsLine(alert.odds, market)
    if (!line) continue // try again on the next attach until the window closes
    awaitingOdds.delete(key)
    upsertTelegramMessage(key, { oddsLine: line, oddsAt: new Date(now).toISOString() })
    void requestTelegramAlertEdit(key, 'odds')
    queued.push(key)
  }
  return queued
}

export async function waitForTelegramEditsForTests(): Promise<void> {
  while (chains.size) {
    await Promise.all([...chains.values()])
  }
}

export function resetTelegramEditsForTests(): void {
  chains.clear()
  awaitingOdds.clear()
}
