import { useEffect, useState } from 'react'
import type { GameSync } from '../sync/engine'

/** Server time (ms), corrected for this phone's clock offset, ticking every intervalMs. */
export function useServerNow(sync: GameSync | null, intervalMs = 500): number {
  const [now, setNow] = useState(() => sync?.serverNow() ?? Date.now())
  useEffect(() => {
    if (!sync) return
    const t = setInterval(() => setNow(sync.serverNow()), intervalMs)
    return () => clearInterval(t)
  }, [sync, intervalMs])
  return now
}

export const mmss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
