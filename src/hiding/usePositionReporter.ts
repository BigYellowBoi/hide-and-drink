import { useEffect, useRef, useState } from 'react'
import type { GameSync } from '../sync/engine'
import type { ActionResult } from '../sync/transport'
import type { Fix } from './useGeolocation'

type Send = (sync: GameSync, lng: number, lat: number, accuracyM: number | null) => Promise<ActionResult>
const sendPosition: Send = (sync, lng, lat, acc) => sync.reportPosition(lng, lat, acc)
/** Hiders: the replay track only (server-side, hidden from everyone until the game ends). */
export const sendTrack: Send = (sync, lng, lat, acc) => sync.reportTrack(lng, lat, acc)

/**
 * Seekers: send the latest GPS fix to teammates (and the server's freeze check) every
 * intervalS while live. Nothing is queued: a fix that can't be sent now is replaced by the next.
 * A newly placed dev/playtest point is sent at once, so freeze tests don't wait an interval.
 * Returns the local time of the last successful report. send: report_position (seekers, the
 * default) or report_track (hiders: recorded for the replay, never shown to seekers).
 */
export function usePositionReporter(
  sync: GameSync,
  fix: Fix | null,
  canAct: boolean,
  intervalS: number,
  enabled: boolean,
  send: Send = sendPosition,
) {
  const [lastSent, setLastSent] = useState<number | null>(null)
  const fixRef = useRef(fix)
  const canActRef = useRef(canAct)
  useEffect(() => {
    fixRef.current = fix
    canActRef.current = canAct
  }, [fix, canAct])

  useEffect(() => {
    if (!enabled) return
    let last: number | null = null
    let sentAt: number | null = null
    let inFlight = false
    const tick = async () => {
      const f = fixRef.current
      if (!f || !canActRef.current || inFlight) return
      const moved = f.fake === true && f.at !== sentAt
      if (!moved && last !== null && Date.now() - last < intervalS * 1000) return
      inFlight = true
      try {
        const res = await send(sync, f.lng, f.lat, f.accuracyM)
        if (res.ok) {
          last = Date.now()
          sentAt = f.at
          setLastSent(last)
        } else if (res.code !== 'not_live') {
          last = Date.now() // refused or failed: wait a full interval rather than retry every second
          sentAt = f.at
        }
      } finally {
        inFlight = false
      }
    }
    void tick()
    const t = setInterval(() => void tick(), 1000)
    return () => clearInterval(t)
  }, [sync, intervalS, enabled, send])

  return lastSent
}
