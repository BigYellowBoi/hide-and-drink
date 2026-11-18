import type { SyncTransport } from '../sync/transport'

/**
 * Web push opt-in. The phone subscribes with the app's VAPID public key and saves the
 * subscription with save_push_subscription; the server (push_outbox + send-push) decides
 * who gets which alert. Alerts arrive only through the installed service worker
 * (public/push-sw.js), so on iPhone the app must be added to the Home Screen first.
 */

export const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? ''

export type PushSupport = 'ok' | 'not_configured' | 'needs_home_screen' | 'unsupported'

export interface PushEnv {
  vapidKey: string
  hasServiceWorker: boolean
  hasPushManager: boolean
  hasNotification: boolean
  /** iPhone/iPad Safari (push only works from the Home Screen app there). */
  ios: boolean
  standalone: boolean
}

/** Whether this phone can get alerts, and if not, why. Pure, for tests. */
export function pushSupport(env: PushEnv): PushSupport {
  if (!env.vapidKey) return 'not_configured'
  if (env.ios && !env.standalone) return 'needs_home_screen'
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return 'unsupported'
  return 'ok'
}

export function currentPushEnv(): PushEnv {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined
  const win = typeof window !== 'undefined' ? window : undefined
  const ua = nav?.userAgent ?? ''
  return {
    vapidKey: VAPID_PUBLIC_KEY,
    hasServiceWorker: !!nav && 'serviceWorker' in nav,
    hasPushManager: !!win && 'PushManager' in win,
    hasNotification: !!win && 'Notification' in win,
    ios: /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1),
    standalone:
      !!win &&
      (win.matchMedia?.('(display-mode: standalone)').matches || (nav as { standalone?: boolean } | undefined)?.standalone === true),
  }
}

/** The VAPID key (base64url) as the bytes PushManager.subscribe wants. */
export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

/** The parts of a PushSubscription the server stores. */
export function subscriptionArgs(sub: PushSubscriptionJSON): { p_endpoint: string; p_p256dh: string; p_auth: string } {
  const endpoint = sub.endpoint ?? ''
  const p256dh = sub.keys?.p256dh ?? ''
  const auth = sub.keys?.auth ?? ''
  if (!endpoint || !p256dh || !auth) throw new Error('invalid_push_subscription')
  return { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth }
}

async function registration(): Promise<ServiceWorkerRegistration> {
  // Resolves once the PWA's service worker is active (never in `npm run dev`).
  return navigator.serviceWorker.ready
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushSupport(currentPushEnv()) !== 'ok') return null
  const reg = await registration()
  return reg.pushManager.getSubscription()
}

async function save(transport: SyncTransport, sub: PushSubscription): Promise<void> {
  await transport.signIn()
  const res = await transport.call('save_push_subscription', subscriptionArgs(sub.toJSON()))
  if (!res.ok) throw new Error(res.code)
}

/** Ask for permission (needs a tap), subscribe and save. Returns false if refused. */
export async function enablePush(transport: SyncTransport): Promise<boolean> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return false
  const reg = await registration()
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }))
  await save(transport, sub)
  return true
}

export async function disablePush(transport: SyncTransport): Promise<void> {
  const sub = await currentSubscription()
  if (!sub) return
  await transport.call('delete_push_subscription', { p_endpoint: sub.endpoint }).catch(() => {})
  await sub.unsubscribe()
}

/**
 * Save an existing subscription again (on app start): the browser may have rotated it, and
 * a new anonymous sign-in on this phone needs it under the new user.
 */
export async function refreshPush(transport: SyncTransport): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  const sub = await currentSubscription()
  if (sub) await save(transport, sub)
}
