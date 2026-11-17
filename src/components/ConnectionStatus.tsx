import { useEffect, useState } from 'react'
import type { SyncStatus } from '../sync/engine'
import { bannerDelayMs } from '../sync/lockout'

const LABELS: Record<SyncStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  live: 'Live',
  offline: 'Offline',
  error: 'Error',
}

/** Statuses that usually clear on their own within a moment (e.g. two topics arriving out of order). */
const BRIEF = new Set<SyncStatus>(['connecting', 'syncing'])

/**
 * Show a brief connecting/syncing blip as live, like the stale banner and the dimmed screen
 * do. Display only: actions still wait for the engine's real status (canAct).
 */
function useShownStatus(status: SyncStatus): SyncStatus {
  const [shown, setShown] = useState(status)
  useEffect(() => {
    if (!(BRIEF.has(status) && shown === 'live')) {
      // oxlint-disable-next-line react/set-state-in-effect
      setShown(status)
      return
    }
    const t = setTimeout(() => setShown(status), bannerDelayMs(status))
    return () => clearTimeout(t)
  }, [status, shown])
  return shown
}

/**
 * Status dot for the top bar. Anything but green means actions are paused; the stale banner
 * says why, so here the label only shows when not live.
 */
export function ConnectionStatus({ status, canAct }: { status: SyncStatus; canAct: boolean }) {
  const shown = useShownStatus(status)
  const paused = !canAct && shown !== 'idle' && shown !== 'live'
  const label = `${LABELS[shown]}${paused ? ', actions paused' : ''}`
  return (
    <span className={`conn conn-${shown}`} role="status" aria-live="polite" aria-label={label} title={label}>
      {shown !== 'live' && <span aria-hidden="true">{LABELS[shown]}</span>}
      <span className="conn-dot" aria-hidden="true" />
    </span>
  )
}
