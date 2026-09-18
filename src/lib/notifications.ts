import { formatSigned, minuteLabel, sideLabel } from './format'
import { RULE_SHORT } from './rules'
import type { AlertSettings, FeedAlert, RuleId } from './types'

export type NotifyPermission = NotificationPermission | 'unsupported'

export function feedAlertKey(alert: Pick<FeedAlert, 'fixtureId' | 'id'>): string {
  return `${alert.fixtureId}:${alert.id}`
}

export function alertDomId(key: string): string {
  return `alert-${key.replace(/[^a-zA-Z0-9_-]/g, '-')}`
}

export function notificationsSupported(): boolean {
  return typeof window !== 'undefined' && 'Notification' in window && 'serviceWorker' in navigator
}

export function currentPermission(): NotifyPermission {
  if (typeof window === 'undefined' || !('Notification' in window)) return 'unsupported'
  return Notification.permission
}

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' })
  } catch {
    return null
  }
}

export async function requestNotificationPermission(): Promise<NotifyPermission> {
  if (!notificationsSupported()) return 'unsupported'
  await registerServiceWorker()
  return Notification.requestPermission()
}

export function ruleNotifyEnabled(settings: AlertSettings, rule: RuleId): boolean {
  if (!settings.notificationsEnabled) return false
  if (rule === 'primary') return settings.notifyPrimary
  if (rule === 'secondary') return settings.notifySecondary
  return settings.notifyFallback
}

export function alertUrl(alertKey: string): string {
  return `${window.location.origin}/#/monitor?alert=${encodeURIComponent(alertKey)}`
}

function notificationCopy(alert: FeedAlert): { title: string; body: string } {
  return {
    title: `${RULE_SHORT[alert.rule]} · ${alert.matchLabel}`,
    body: `${minuteLabel(alert.min, alert.period)} · ${sideLabel(alert.side)} · v ${formatSigned(alert.momentum)}`,
  }
}

export async function showAlertNotification(alert: FeedAlert): Promise<void> {
  if (!notificationsSupported()) return
  if (Notification.permission !== 'granted') return

  const key = feedAlertKey(alert)
  const { title, body } = notificationCopy(alert)
  const payload = {
    type: 'SHOW_NOTIFICATION' as const,
    title,
    body,
    tag: `pregoal:${key}`,
    url: alertUrl(key),
    alertKey: key,
  }

  const ready = await navigator.serviceWorker.ready.catch(() => null)
  if (ready?.active) {
    ready.active.postMessage(payload)
    return
  }

  const registration = await registerServiceWorker()
  if (registration?.active) {
    registration.active.postMessage(payload)
    return
  }

  new Notification(title, {
    body,
    tag: payload.tag,
    icon: '/icons/icon-192.png',
  })
}

export function buildTestAlert(): FeedAlert {
  return {
    id: 'primary-1-38-0',
    fixtureId: 'demo-teste',
    matchLabel: 'Celtic vs Ferencváros',
    firedAt: new Date().toISOString(),
    coincident: false,
    rule: 'primary',
    ruleName: 'Primária · Spike80 ∧ (Swing50 ∨ Sustained3)',
    min: 38,
    period: 1,
    index: 0,
    side: 'away',
    momentum: -61,
    delta1: -63,
    sustainedLength: 1,
    signals: {
      spike: false,
      swingCombo: true,
      swingSecondary: true,
      sustainedCombo: false,
      sustainedFallback: false,
    },
  }
}

export function showTestNotification(): Promise<void> {
  return showAlertNotification(buildTestAlert())
}

export function parseAppHash(hash = window.location.hash): {
  tab: 'monitor' | 'replay' | 'definicoes'
  alertKey: string | null
} {
  const raw = hash.replace(/^#\/?/, '')
  const [path, query] = raw.split('?')
  const tab =
    path === 'replay' || path === 'definicoes' || path === 'monitor'
      ? path
      : 'monitor'
  const params = new URLSearchParams(query ?? '')
  return { tab, alertKey: params.get('alert') }
}
