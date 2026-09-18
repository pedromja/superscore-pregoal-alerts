/* SuperScore pre-goal alerts — local notifications (no Web Push/VAPID yet). */
const SW_VERSION = 'pregoal-notify-v1'

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('message', (event) => {
  const data = event.data
  if (!data || data.type !== 'SHOW_NOTIFICATION') return

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      tag: data.tag,
      renotify: true,
      vibrate: [80, 40, 80],
      data: {
        url: data.url,
        alertKey: data.alertKey,
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
    const origin = self.location.origin
    if (!client.url.startsWith(origin)) continue
    await client.focus()
    client.postMessage({ type: 'OPEN_ALERT', url: target })
    return
  }
  await self.clients.openWindow(target)
}
