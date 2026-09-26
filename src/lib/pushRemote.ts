import { registerServiceWorker } from './notifications'

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob(base64.replace(/-/g, '+').replace(/_/g, '/') + padding)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i)
  return out
}

export async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch('/api/push/vapidPublicKey')
  if (!res.ok) throw new Error('Servidor Push indisponível')
  const data = (await res.json()) as { publicKey: string }
  return data.publicKey
}

export async function currentPushSubscription(): Promise<PushSubscription | null> {
  const reg = await registerServiceWorker()
  if (!reg) return null
  return reg.pushManager.getSubscription()
}

export async function subscribeRemotePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new Error('Permissão recusada')
  const reg = await registerServiceWorker()
  if (!reg) throw new Error('Service Worker indisponível')
  await navigator.serviceWorker.ready
  const publicKey = await fetchVapidPublicKey()
  const existing = await reg.pushManager.getSubscription()
  const sub =
    existing ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    }))
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(sub.toJSON()),
  })
  if (!res.ok) throw new Error('Falha a guardar a subscription')
  return sub
}

export async function unsubscribeRemotePush(): Promise<void> {
  const sub = await currentPushSubscription()
  if (!sub) return
  await fetch('/api/push/subscribe', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  })
  await sub.unsubscribe()
}

export async function sendRemoteTest(
  market?: import('./types').Market,
): Promise<{ sent: number }> {
  const url = market
    ? `/api/push/test?market=${encodeURIComponent(market)}`
    : '/api/push/test'
  const res = await fetch(url, { method: 'POST' })
  if (!res.ok) throw new Error('Falha no teste remoto')
  return (await res.json()) as { sent: number }
}
