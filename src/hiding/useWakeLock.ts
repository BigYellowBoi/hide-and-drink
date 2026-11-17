import { useEffect, useState } from 'react'

export type WakeLockState = 'off' | 'on' | 'unsupported' | 'failed'

/**
 * Keep the screen on while enabled (Screen Wake Lock API: Safari 16.4+, Chrome). The browser
 * drops the lock whenever the page is hidden, so it is requested again on every return.
 * This is how a seeker phone keeps sharing its location: web apps get no GPS in the background.
 */
export function useWakeLock(enabled: boolean): WakeLockState {
  const supported = typeof navigator !== 'undefined' && 'wakeLock' in navigator
  const [state, setState] = useState<WakeLockState>('off')

  useEffect(() => {
    if (!enabled || !supported) return
    let sentinel: WakeLockSentinel | null = null
    let live = true
    const acquire = async () => {
      if (document.visibilityState !== 'visible' || (sentinel && !sentinel.released)) return
      try {
        sentinel = await navigator.wakeLock.request('screen')
        if (!live) {
          void sentinel.release()
          return
        }
        setState('on')
        sentinel.addEventListener('release', () => live && setState('off'))
      } catch {
        // Low battery mode, or the page isn't visible yet: the next visibility change retries.
        if (live) setState('failed')
      }
    }
    void acquire()
    document.addEventListener('visibilitychange', acquire)
    return () => {
      live = false
      document.removeEventListener('visibilitychange', acquire)
      void sentinel?.release()
    }
  }, [enabled, supported])

  if (!supported) return 'unsupported'
  return enabled ? state : 'off'
}
