import {
  publicAppUrl,
  telegramEnabled,
  telegramUpdatesMode,
  telegramWebhookSecret,
} from './config.ts'
import { callTelegramApi } from './telegram.ts'
import { handleTelegramUpdate } from './telegramResolve.ts'

let pollAbort: AbortController | null = null
let pollRunning = false

export function telegramWebhookUrl(): string {
  return `${publicAppUrl()}/api/telegram/webhook`
}

export function telegramWebhookAuthorized(secret: string): boolean {
  const expected = telegramWebhookSecret()
  if (!expected) return false
  return secret === expected
}

export function acceptTelegramWebhook(secret: string, body: unknown): boolean {
  if (!telegramWebhookAuthorized(secret)) return false
  void handleTelegramUpdate(body)
  return true
}

export async function registerTelegramWebhook(): Promise<boolean> {
  if (!telegramEnabled()) return false
  const secret = telegramWebhookSecret()
  const url = telegramWebhookUrl()
  try {
    const parsed = await callTelegramApi('setWebhook', {
      url,
      secret_token: secret,
      allowed_updates: ['callback_query'],
    })
    if (!parsed.ok) {
      console.warn(
        '[telegram] setWebhook',
        parsed.description || parsed.httpStatus,
      )
      return false
    }
    console.log('[telegram] webhook', url)
    return true
  } catch (err) {
    console.warn(
      '[telegram] setWebhook',
      err instanceof Error ? err.message : err,
    )
    return false
  }
}

async function deleteTelegramWebhook(): Promise<void> {
  try {
    await callTelegramApi('deleteWebhook', { drop_pending_updates: false })
  } catch {
    // ignore
  }
}

type UpdateRow = {
  update_id?: number
  callback_query?: unknown
}

export async function dispatchTelegramUpdates(
  updates: UpdateRow[],
): Promise<number> {
  let next = 0
  for (const update of updates) {
    if (typeof update.update_id === 'number') {
      next = Math.max(next, update.update_id + 1)
    }
    await handleTelegramUpdate(update)
  }
  return next
}

function startLongPoll(): void {
  if (pollRunning) return
  pollAbort?.abort()
  pollAbort = new AbortController()
  pollRunning = true
  const signal = pollAbort.signal
  void (async () => {
    let offset = 0
    while (!signal.aborted) {
      try {
        const parsed = await callTelegramApi(
          'getUpdates',
          {
            offset,
            timeout: 25,
            allowed_updates: ['callback_query'],
          },
          30_000,
        )
        if (!parsed.ok || !Array.isArray(parsed.result)) {
          if (!signal.aborted) await new Promise((r) => setTimeout(r, 1500))
          continue
        }
        offset = await dispatchTelegramUpdates(parsed.result as UpdateRow[])
      } catch (err) {
        if (signal.aborted) break
        const message = err instanceof Error ? err.message : String(err)
        if (/timeout|aborted/i.test(message)) continue
        console.warn('[telegram] long-poll', message)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    pollRunning = false
  })()
  console.log('[telegram] long-poll callback_query')
}

export async function startTelegramUpdates(): Promise<void> {
  if (!telegramEnabled()) return
  const mode = telegramUpdatesMode()
  if (mode === 'off') return
  if (mode === 'poll') {
    await deleteTelegramWebhook()
    startLongPoll()
    return
  }
  const ok = await registerTelegramWebhook()
  if (!ok) {
    console.warn('[telegram] webhook falhou — a usar long-poll')
    startLongPoll()
  }
}

export function stopTelegramUpdatesForTests(): void {
  pollAbort?.abort()
  pollAbort = null
  pollRunning = false
}
