import { useEffect, useState } from 'react'
import type { GameSync } from '../sync/engine'

/** Server time (corrected for this phone's clock offset), re-rendering every tickMs. */
export function useServerNow(sync: GameSync, tickMs = 250): number {
  const [now, setNow] = useState(() => sync.serverNow())
  useEffect(() => {
    const t = setInterval(() => setNow(sync.serverNow()), tickMs)
    return () => clearInterval(t)
  }, [sync, tickMs])
  return now
}
