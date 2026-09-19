import {
  publicAppUrl,
  TELEGRAM_TIMEOUT_MS,
  telegramBotToken,
  telegramChatId,
  telegramConfigured,
  telegramEnabled,
} from './config.ts'

export type TelegramPayload = {
  title: string
  body: string
  url: string
  alertKey: string
  ruleLabel?: string
}

export type TelegramSendResult = {
  sent: number
  skipped: boolean
  reason?: string
}

export type TelegramStatus = {
  configured: boolean
  enabled: boolean
  lastSendAt: string | null
  lastError: string | null
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

export function getTelegramStatus(): TelegramStatus {
  return {
    ...status,
    configured: telegramConfigured(),
    enabled: telegramEnabled(),
  }
}

function sanitizeError(message: string, token: string): string {
  if (!token) return message
  return message.split(token).join('<token>')
}

function recordFailure(alertKey: string, reason: string): TelegramSendResult {
  status.lastError = reason
  console.error('[telegram] falhou', alertKey, reason)
  return { sent: 0, skipped: false, reason }
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
  const endpoint = `https://api.telegram.org/bot${token}/sendMessage`

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(TELEGRAM_TIMEOUT_MS),
    })
    const raw = await res.text()
    let description = ''
    try {
      const parsed = JSON.parse(raw) as {
        ok?: boolean
        description?: string
      }
      if (parsed.ok === true) {
        status.lastSendAt = new Date().toISOString()
        status.lastError = null
        return { sent: 1, skipped: false }
      }
      description = parsed.description || ''
    } catch {
      description = raw.slice(0, 180)
    }
    const reason = sanitizeError(
      `HTTP ${res.status}${description ? `: ${description}` : ''}`,
      token,
    )
    return recordFailure(payload.alertKey, reason)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const timedOut =
      err instanceof Error &&
      (err.name === 'TimeoutError' || /timeout|aborted/i.test(message))
    const reason = sanitizeError(
      timedOut ? `timeout ${TELEGRAM_TIMEOUT_MS}ms` : message,
      token,
    )
    return recordFailure(payload.alertKey, reason)
  }
}
