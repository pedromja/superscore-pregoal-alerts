/* SuperScore — local SHOW_NOTIFICATION + Web Push */
const SW_VERSION = 'pregoal-push-v2'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function show(title, options) {
  return self.registration.showNotification(title, {
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    renotify: true,
    vibrate: [80, 40, 80],
    ...options,
  })
}

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'SHOW_NOTIFICATION') return
  event.waitUntil(
    show(data.title, {
      body: data.body,
      tag: data.tag,
      data: { url: data.url, alertKey: data.alertKey, version: SW_VERSION },
    }),
  )
})

self.addEventListener('push', (event) => {
  let payload = {
    title: 'Alerta pré-golo',
    body: 'Novo momentum SuperScore',
    url: '/#/monitor',
    alertKey: '',
    tag: `pregoal:${Date.now()}`,
  }
  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    if (event.data) payload.body = event.data.text()
  }
  event.waitUntil(
    show(payload.title, {
      body: payload.body,
      tag: payload.tag,
      data: {
        url: payload.url || '/#/monitor',
        alertKey: payload.alertKey,
        version: SW_VERSION,
      },
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = event.notification.data?.url || '/#/monitor'
  event.waitUntil(openOrFocus(target))
})

async function openOrFocus(target) {
  const windowClients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  })
  for (const client of windowClients) {
    if (!client.url.startsWith(self.location.origin)) continue
    await client.focus()
    client.postMessage({ type: 'OPEN_ALERT', url: target })
    return
  }
  await self.clients.openWindow(target)
}
