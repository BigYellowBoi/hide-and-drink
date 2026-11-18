import { useEffect, useState } from 'react'
import { msToNextTick } from '../lib/timers'
import type { GameSync } from '../sync/engine'

/**
 * Server time (corrected for this phone's clock offset), re-rendering on each whole tickMs
 * of server time so every phone's countdowns change on the same second. Stops while the app
 * is hidden and catches up straight away when it comes back.
 */
export function useServerNow(sync: GameSync, tickMs = 1000): number {
  const [now, setNow] = useState(() => sync.serverNow())
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | null = null
    const schedule = () => {
      if (t) clearTimeout(t)
      t = null
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      t = setTimeout(() => {
        setNow(sync.serverNow())
        schedule()
      }, msToNextTick(sync.serverNow(), tickMs))
    }
    const onVisible = () => {
      setNow(sync.serverNow())
      schedule()
    }
    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (t) clearTimeout(t)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [sync, tickMs])
  return now
}
