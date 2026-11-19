import { useEffect, useState } from 'react'
import { readLocal, writeLocal } from '../lib/storage'
import type { LogEntry } from './state'

const key = (gameId: string) => `hd.logSeen.${gameId}`

/** Seq of the newest timeline entry someone else caused (0: none). */
export function latestOthers(log: readonly Pick<LogEntry, 'seq' | 'by'>[], userId: string | null): number {
  let max = 0
  for (const e of log) if (e.seq > max && (!userId || e.by !== userId)) max = e.seq
  return max
}

/**
 * True while the timeline has entries this phone hasn't looked at (the yellow dot on its tab).
 * Looking at the timeline marks everything seen; kept per game on the phone.
 */
export function useTimelineUnseen(gameId: string, log: readonly LogEntry[], userId: string | null, viewing: boolean): boolean {
  const latest = latestOthers(log, userId)
  const [seen, setSeen] = useState<number>(() => {
    const v = Number(readLocal(key(gameId)))
    // First time on this phone: nothing is new yet.
    return Number.isFinite(v) && v > 0 ? v : latest
  })
  // Looking at it marks everything seen (set while rendering, React's pattern for derived state).
  if (viewing && latest > seen) setSeen(latest)
  useEffect(() => {
    if (seen > 0) writeLocal(key(gameId), String(seen))
  }, [seen, gameId])
  return !viewing && latest > seen
}
