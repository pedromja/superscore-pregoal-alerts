import webpush from 'web-push'
import { vapid } from './config.ts'
import { loadSubscriptions, saveSubscriptions } from './store.ts'
import type { PushSub } from './types.ts'

webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)

export function publicVapidKey(): string {
  return vapid.publicKey
}

export function addSubscription(sub: PushSub): void {
  const items = loadSubscriptions().filter((s) => s.endpoint !== sub.endpoint)
  items.push(sub)
  saveSubscriptions(items)
}

export function removeSubscription(endpoint: string): void {
  saveSubscriptions(loadSubscriptions().filter((s) => s.endpoint !== endpoint))
}

export type PushSendResult = {
  sent: number
  removed: number
  attempted: number
  errors: string[]
}

function pushErrorReason(err: unknown): { status?: number; reason: string } {
  const status = (err as { statusCode?: number }).statusCode
  const body = (err as { body?: string }).body
  const message = err instanceof Error ? err.message : String(err)
  const detail = body?.trim() ? `${message} ${body}`.trim() : message
  return {
    status,
    reason: status ? `HTTP ${status}: ${detail}` : detail,
  }
}

export async function sendPushToAll(payload: {
  title: string
  body: string
  url: string
  alertKey: string
  tag?: string
}): Promise<PushSendResult> {
  const subs = loadSubscriptions()
  const errors: string[] = []
  if (!subs.length) {
    const reason = 'sem subscritores'
    return { sent: 0, removed: 0, attempted: 0, errors: [reason] }
  }
  let sent = 0
  let removed = 0
  const body = JSON.stringify(payload)
  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: sub.keys,
        },
        body,
      )
      sent += 1
    } catch (err) {
      const { status, reason } = pushErrorReason(err)
      console.error(
        '[push] falhou',
        payload.alertKey,
        sub.endpoint.slice(0, 64),
        reason,
      )
      errors.push(reason)
      if (status === 404 || status === 410) {
        removeSubscription(sub.endpoint)
        removed += 1
      }
    }
  }
  if (sent === 0) {
    console.error(
      '[push] nenhum envio',
      payload.alertKey,
      errors.join(' | ') || 'sem detalhe',
    )
  }
  return { sent, removed, attempted: subs.length, errors }
}
