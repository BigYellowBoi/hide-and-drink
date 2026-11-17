import { useEffect, useState } from 'react'
import type { SyncStatus } from '../sync/engine'
import { bannerDelayMs, formatStaleFor, lockoutFor } from '../sync/lockout'

/**
 * Stale-state lockout banner. Shown whenever this phone may be out of date, so nobody acts
 * on an old view. The game screen is inert meanwhile (see App), and actions refuse anyway.
 */
export function StaleBanner({ status, staleSince }: { status: SyncStatus; staleSince: number | null }) {
  const [now, setNow] = useState(() => Date.now())
  const [shown, setShown] = useState(false)
  const locked = lockoutFor(status, staleSince, now) !== null

  // Tick the "out of date" counter while locked; hide again once live.
  useEffect(() => {
    if (!locked) return
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(tick)
      setShown(false)
    }
  }, [locked])

  // Once shown, stay up until live (no flicker between offline and syncing).
  useEffect(() => {
    if (!locked || shown) return
    const t = setTimeout(() => setShown(true), bannerDelayMs(status))
    return () => clearTimeout(t)
  }, [locked, shown, status])

  const lockout = lockoutFor(status, staleSince, now)
  if (!lockout || !shown) return null
  return (
    <div className={`stale-banner stale-${status}`} role="alert">
      <strong>{lockout.title}</strong>
      {lockout.staleForS !== null && lockout.staleForS >= 3 && (
        <span className="stale-for"> · out of date {formatStaleFor(lockout.staleForS)}</span>
      )}
      <p>{lockout.detail}</p>
    </div>
  )
}
