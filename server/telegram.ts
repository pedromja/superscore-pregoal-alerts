import { marketCopy, parseMarket } from '../src/lib/market.ts'
import type { CornerHalf, Market } from '../src/lib/types.ts'
import { createHash } from 'node:crypto'
import {
  publicAppUrl,
  TELEGRAM_TIMEOUT_MS,
  telegramBotToken,
  telegramChatId,
  telegramConfigured,
  telegramEnabled,
} from './config.ts'
import {
  findAlertKeyByCallbackToken,
  markAlertTelegramMessage,
  upsertTelegramMessage,
} from './store.ts'
import { getTelegramRetryStats, type TelegramRetryStats } from './telegramRetry.ts'

export const RESOLVE_NOW_LABEL = 'Resolver agora'
export const PENDING_RESOLVE_TEXT = 'ainda sem resolução'
export const ALREADY_RESOLVED_TEXT = 'já resolvido'
export const RESOLVE_CALLBACK_PREFIX = 'rn:'
const CALLBACK_DATA_MAX = 64

export type TelegramPayload = {
  title: string
  body: string
  url: string
  alertKey: string
  ruleLabel?: string
  /** Stored on the telegram_messages.json record (both markets share that file). */
  market?: Market
}

export type TelegramFailureKind =
  | 'network'
  | 'timeout'
  | 'rate-limit'
  | 'server'
  | 'client'

export type TelegramSendResult = {
  sent: number
  skipped: boolean
  reason?: string
  messageId?: number
  /** Failure classification (unset on success/skip). */
  failureKind?: TelegramFailureKind
  /** Transient: network error, 429 or 5xx. Timeouts/other 4xx are final. */
  retryable?: boolean
  /** From Telegram's 429 `parameters.retry_after` (seconds → ms). */
  retryAfterMs?: number
}

export type TelegramOutcomeInput = {
  hit5: boolean | null
  hitLong: boolean | null
  market?: Market
  cornerHalf?: CornerHalf | null
  matchLabel?: string
  minute?: number | null
}

export type TelegramStatus = {
  configured: boolean
  enabled: boolean
  lastSendAt: string | null
  lastError: string | null
  retry?: TelegramRetryStats
}

const status: TelegramStatus = {
  configured: telegramConfigured(),
  enabled: telegramEnabled(),
  lastSendAt: null,
  lastError: null,
}

type FetchFn = typeof fetch
let fetchImpl: FetchFn = globalThis.fetch

export function setTelegramFetchForTests(fn: FetchFn | null): void {
  fetchImpl = fn ?? globalThis.fetch
}

export function resetTelegramStatusForTests(): void {
  status.configured = telegramConfigured()
  status.enabled = telegramEnabled()
  status.lastSendAt = null
  status.lastError = null
}

export function escapeTelegramHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export function resolveMonitorUrl(pathOrUrl: string): string | null {
  const trimmed = pathOrUrl.trim()
  if (!trimmed) return null
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  const base = publicAppUrl()
  if (!base) return null
  const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`
  return `${base}${path}`
}

export function formatTelegramHtml(payload: TelegramPayload): string {
  const lines = [
    `<b>${escapeTelegramHtml(payload.title)}</b>`,
    escapeTelegramHtml(payload.body),
  ]
  if (payload.ruleLabel) {
    lines.push(escapeTelegramHtml(payload.ruleLabel))
  }
  const href = resolveMonitorUrl(payload.url)
  if (href) {
    lines.push(
      `<a href="${escapeTelegramHtml(href)}">Abrir no monitor</a>`,
    )
  }
  return lines.filter((line) => line.length > 0).join('\n')
}

export function telegramOutcomeIsHit(
  alert: Pick<TelegramOutcomeInput, 'hit5' | 'hitLong'>,
): boolean {
  return alert.hit5 === true || alert.hitLong === true
}

/** Short pt-PT GREEN/RED line. Market, half, match, minute when known. */
export function formatTelegramOutcomeHtml(alert: TelegramOutcomeInput): string {
  const hit = telegramOutcomeIsHit(alert)
  const badge = hit ? '🟢 GREEN' : '🔴 RED'
  const market = marketCopy(parseMarket(alert.market)).pushPrefix
  const half =
    alert.cornerHalf === 'ht' || alert.cornerHalf === 'ft'
      ? alert.cornerHalf.toUpperCase()
      : null
  const bits = [
    market,
    half,
    alert.matchLabel?.trim() || null,
    typeof alert.minute === 'number' && Number.isFinite(alert.minute)
      ? `${alert.minute}'`
      : null,
  ].filter((bit): bit is string => Boolean(bit))
  return `<b>${badge}</b> · ${bits.map(escapeTelegramHtml).join(' · ')}`
}

export function isAllowedTelegramChat(chatId: unknown): boolean {
  const expected = telegramChatId()
  if (!expected) return false
  return String(chatId ?? '') === expected
}

export function buildResolveCallbackData(alertKey: string): string {
  const raw = `${RESOLVE_CALLBACK_PREFIX}${alertKey}`
  if (Buffer.byteLength(raw, 'utf8') <= CALLBACK_DATA_MAX) return raw
  const token = createHash('sha256')
    .update(alertKey)
    .digest('base64url')
    .slice(0, 16)
  upsertTelegramMessage(alertKey, { callbackToken: token })
  return `${RESOLVE_CALLBACK_PREFIX}${token}`
}

export function parseResolveCallbackData(data: string): string | null {
  if (!data.startsWith(RESOLVE_CALLBACK_PREFIX)) return null
  const rest = data.slice(RESOLVE_CALLBACK_PREFIX.length).trim()
  if (!rest) return null
  return findAlertKeyByCallbackToken(rest) ?? rest
}

export function resolveNowKeyboard(alertKey: string): {
  inline_keyboard: { text: string; callback_data: string }[][]
} {
  return {
    inline_keyboard: [
      [{ text: RESOLVE_NOW_LABEL, callback_data: buildResolveCallbackData(alertKey) }],
    ],
  }
}

function persistTelegramMessageId(
  alertKey: string,
  messageId: number,
  text: string,
  market?: Market,
): void {
  const callback = buildResolveCallbackData(alertKey)
  const token = callback.startsWith(RESOLVE_CALLBACK_PREFIX)
    ? callback.slice(RESOLVE_CALLBACK_PREFIX.length)
    : undefined
  upsertTelegramMessage(alertKey, {
    messageId,
    chatId: telegramChatId(),
    text,
    sentAt: new Date().toISOString(),
    callbackToken: token !== alertKey ? token : undefined,
    ...(market ? { market } : {}),
  })
  markAlertTelegramMessage(alertKey, messageId)
}

export function getTelegramStatus(): TelegramStatus {
  return {
    ...status,
    configured: telegramConfigured(),
    enabled: telegramEnabled(),
    retry: getTelegramRetryStats(),
  }
}

function sanitizeError(message: string, token: string): string {
  if (!token) return message
  return message.split(token).join('<token>')
}

function recordFailure(
  alertKey: string,
  reason: string,
  failure: Pick<TelegramSendResult, 'failureKind' | 'retryable' | 'retryAfterMs'> = {},
): TelegramSendResult {
  status.lastError = reason
  console.error('[telegram] falhou', alertKey, reason)
  return { sent: 0, skipped: false, reason, ...failure }
}

/** 429 → rate-limit (retry after `retry_after`); 5xx → server (retry); else final. */
export function classifyTelegramApiFailure(
  parsed: Pick<TelegramApiParsed, 'httpStatus' | 'retryAfterSec'>,
): Pick<TelegramSendResult, 'failureKind' | 'retryable' | 'retryAfterMs'> {
  if (parsed.httpStatus === 429) {
    return {
      failureKind: 'rate-limit',
      retryable: true,
      retryAfterMs:
        parsed.retryAfterSec != null && parsed.retryAfterSec >= 0
          ? parsed.retryAfterSec * 1000
          : undefined,
    }
  }
  if (parsed.httpStatus >= 500) return { failureKind: 'server', retryable: true }
  return { failureKind: 'client', retryable: false }
}

/**
 * Thrown by fetch: a timeout is final (the request may have been delivered);
 * anything else (`fetch failed`, DNS, connect/reset) is a transient network error.
 */
export function classifyTelegramThrown(
  err: unknown,
): Pick<TelegramSendResult, 'failureKind' | 'retryable'> {
  const message = err instanceof Error ? err.message : String(err)
  const timedOut =
    err instanceof Error &&
    (err.name === 'TimeoutError' || /timeout|aborted/i.test(message))
  if (timedOut) return { failureKind: 'timeout', retryable: false }
  return { failureKind: 'network', retryable: true }
}

export type TelegramApiParsed = {
  ok: boolean
  description: string
  messageId?: number
  httpStatus: number
  result?: unknown
  retryAfterSec?: number
}

export async function callTelegramApi(
  method: string,
  body: Record<string, unknown>,
  timeoutMs = TELEGRAM_TIMEOUT_MS,
): Promise<TelegramApiParsed> {
  const token = telegramBotToken()
  const endpoint = `https://api.telegram.org/bot${token}/${method}`
  const res = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const raw = await res.text()
  try {
    const parsed = JSON.parse(raw) as {
      ok?: boolean
      description?: string
      result?: { message_id?: number } | unknown[]
      parameters?: { retry_after?: number }
    }
    const messageId = parsed.result?.message_id
    const retryAfter = parsed.parameters?.retry_after
    return {
      ok: parsed.ok === true,
      description: parsed.description || '',
      messageId: typeof messageId === 'number' ? messageId : undefined,
      httpStatus: res.status,
      result: parsed.result,
      ...(typeof retryAfter === 'number' ? { retryAfterSec: retryAfter } : {}),
    }
  } catch {
    return {
      ok: false,
      description: raw.slice(0, 180),
      httpStatus: res.status,
    }
  }
}

function reasonFromApi(parsed: TelegramApiParsed, token: string): string {
  return sanitizeError(
    `HTTP ${parsed.httpStatus}${parsed.description ? `: ${parsed.description}` : ''}`,
    token,
  )
}

export async function sendTelegramAlert(
  payload: TelegramPayload,
): Promise<TelegramSendResult> {
  status.configured = telegramConfigured()
  status.enabled = telegramEnabled()
  if (!status.enabled) {
    const reason = status.configured ? 'desligado' : 'não configurado'
    return { sent: 0, skipped: true, reason }
  }

  const token = telegramBotToken()
  const chatId = telegramChatId()
  const text = formatTelegramHtml(payload)

  try {
    const parsed = await callTelegramApi('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: resolveNowKeyboard(payload.alertKey),
    })
    if (parsed.ok) {
      status.lastSendAt = new Date().toISOString()
      status.lastError = null
      if (parsed.messageId != null) {
        persistTelegramMessageId(
          payload.alertKey,
          parsed.messageId,
          text,
          payload.market,
        )
      }
      return { sent: 1, skipped: false, messageId: parsed.messageId }
    }
    return recordFailure(
      payload.alertKey,
      reasonFromApi(parsed, token),
      classifyTelegramApiFailure(parsed),
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const failure = classifyTelegramThrown(err)
    const reason = sanitizeError(
      failure.failureKind === 'timeout' ? `timeout ${TELEGRAM_TIMEOUT_MS}ms` : message,
      token,
    )
    return recordFailure(payload.alertKey, reason, failure)
  }
}

/**
 * Best-effort GREEN/RED follow-up. Prefers reply_to_message_id; if that
 * fails, tries editMessageText (original + outcome); else a short new message.
 */
export async function sendTelegramOutcomeNotice(args: {
  alertKey: string
  text: string
  replyToMessageId?: number
  originalText?: string
}): Promise<TelegramSendResult> {
  status.configured = telegramConfigured()
  status.enabled = telegramEnabled()
  if (!status.enabled) {
    const reason = status.configured ? 'desligado' : 'não configurado'
    return { sent: 0, skipped: true, reason }
  }

  const token = telegramBotToken()
  const chatId = telegramChatId()
  const { alertKey, text, replyToMessageId, originalText } = args

  const sendStandalone = async (
    replyTo?: number,
  ): Promise<{ parsed: TelegramApiParsed } | { error: TelegramSendResult }> => {
    try {
      const parsed = await callTelegramApi('sendMessage', {
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
        ...(replyTo != null ? { reply_to_message_id: replyTo } : {}),
      })
      return { parsed }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const timedOut =
        err instanceof Error &&
        (err.name === 'TimeoutError' || /timeout|aborted/i.test(message))
      return {
        error: recordFailure(
          alertKey,
          sanitizeError(
            timedOut ? `timeout ${TELEGRAM_TIMEOUT_MS}ms` : message,
            token,
          ),
        ),
      }
    }
  }

  if (replyToMessageId != null) {
    const replied = await sendStandalone(replyToMessageId)
    if ('error' in replied) return replied.error
    if (replied.parsed.ok) {
      status.lastSendAt = new Date().toISOString()
      status.lastError = null
      return { sent: 1, skipped: false, messageId: replied.parsed.messageId }
    }

    if (originalText) {
      try {
        const edited = await callTelegramApi('editMessageText', {
          chat_id: chatId,
          message_id: replyToMessageId,
          text: `${originalText}\n\n${text}`,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        })
        if (edited.ok) {
          status.lastSendAt = new Date().toISOString()
          status.lastError = null
          return { sent: 1, skipped: false, messageId: replyToMessageId }
        }
      } catch {
        // fall through to a short new message
      }
    }
  }

  const fresh = await sendStandalone()
  if ('error' in fresh) return fresh.error
  if (fresh.parsed.ok) {
    status.lastSendAt = new Date().toISOString()
    status.lastError = null
    return { sent: 1, skipped: false, messageId: fresh.parsed.messageId }
  }
  return recordFailure(alertKey, reasonFromApi(fresh.parsed, token))
}

export async function answerTelegramCallback(
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!telegramEnabled() || !callbackQueryId) return
  try {
    await callTelegramApi('answerCallbackQuery', {
      callback_query_id: callbackQueryId,
      ...(text ? { text, show_alert: false } : {}),
    })
  } catch (err) {
    console.warn(
      '[telegram] answerCallbackQuery',
      err instanceof Error ? err.message : err,
    )
  }
}

export async function sendTelegramText(args: {
  alertKey: string
  text: string
  replyToMessageId?: number
}): Promise<TelegramSendResult> {
  status.configured = telegramConfigured()
  status.enabled = telegramEnabled()
  if (!status.enabled) {
    const reason = status.configured ? 'desligado' : 'não configurado'
    return { sent: 0, skipped: true, reason }
  }
  const token = telegramBotToken()
  try {
    const parsed = await callTelegramApi('sendMessage', {
      chat_id: telegramChatId(),
      text: args.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      ...(args.replyToMessageId != null
        ? { reply_to_message_id: args.replyToMessageId }
        : {}),
    })
    if (parsed.ok) {
      status.lastSendAt = new Date().toISOString()
      status.lastError = null
      return { sent: 1, skipped: false, messageId: parsed.messageId }
    }
    return recordFailure(args.alertKey, reasonFromApi(parsed, token))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return recordFailure(args.alertKey, sanitizeError(message, token))
  }
}
