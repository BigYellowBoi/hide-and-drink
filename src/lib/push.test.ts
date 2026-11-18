import { describe, expect, it } from 'vitest'
import { pushSupport, subscriptionArgs, urlBase64ToUint8Array, type PushEnv } from './push'

const env: PushEnv = {
  vapidKey: 'BEl6',
  hasServiceWorker: true,
  hasPushManager: true,
  hasNotification: true,
  ios: false,
  standalone: false,
}

describe('push', () => {
  it('works on a browser with push and a configured key', () => {
    expect(pushSupport(env)).toBe('ok')
  })

  it('needs the VAPID key', () => {
    expect(pushSupport({ ...env, vapidKey: '' })).toBe('not_configured')
  })

  it('needs the Home Screen app on iPhone', () => {
    expect(pushSupport({ ...env, ios: true, hasPushManager: false })).toBe('needs_home_screen')
    expect(pushSupport({ ...env, ios: true, standalone: true })).toBe('ok')
  })

  it('reports browsers without push', () => {
    expect(pushSupport({ ...env, hasPushManager: false })).toBe('unsupported')
  })

  it('decodes base64url keys', () => {
    expect(Array.from(urlBase64ToUint8Array('AQID_w'))).toEqual([1, 2, 3, 255])
  })

  it('takes the endpoint and keys from a subscription', () => {
    expect(subscriptionArgs({ endpoint: 'https://p/1', keys: { p256dh: 'k', auth: 'a' } })).toEqual({
      p_endpoint: 'https://p/1',
      p_p256dh: 'k',
      p_auth: 'a',
    })
    expect(() => subscriptionArgs({ endpoint: 'https://p/1' })).toThrow()
  })
})
