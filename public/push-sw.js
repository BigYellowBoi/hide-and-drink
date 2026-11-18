/* Push alerts in the service worker (imported by the generated sw.js, see vite.config.ts).
 * The payload is { title, body, tag, game_id } from supabase/functions/send-push.
 * While the app is open and on screen it already shows everything live, so no alert then. */

self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Hide + Drink', body: event.data ? event.data.text() : '' }
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.some((w) => w.visibilityState === 'visible' && w.focused)) return
      const base = self.registration.scope
      return self.registration.showNotification(data.title || 'Hide + Drink', {
        body: data.body || '',
        tag: data.tag,
        renotify: !!data.tag,
        icon: base + 'pwa-192.png',
        badge: base + 'mark.svg',
        vibrate: [200, 100, 200],
        data: { url: base },
      })
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || self.registration.scope
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const open = windows.find((w) => w.url.startsWith(self.registration.scope))
      return open ? open.focus() : self.clients.openWindow(url)
    }),
  )
})
