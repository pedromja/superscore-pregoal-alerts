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

export async function sendPushToAll(payload: {
  title: string
  body: string
  url: string
  alertKey: string
  tag?: string
}): Promise<{ sent: number; removed: number }> {
  const subs = loadSubscriptions()
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
      const status = (err as { statusCode?: number }).statusCode
      if (status === 404 || status === 410) {
        removeSubscription(sub.endpoint)
        removed += 1
      }
    }
  }
  return { sent, removed }
}
