import type { SyncStatus } from '../sync/engine'

const LABELS: Record<SyncStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  live: 'Live',
  offline: 'Offline',
  error: 'Error',
}

/**
 * Status dot for the top bar. Anything but green means actions are paused; the stale banner
 * says why, so here the label only shows when not live.
 */
export function ConnectionStatus({ status, canAct }: { status: SyncStatus; canAct: boolean }) {
  const paused = !canAct && status !== 'idle'
  const label = `${LABELS[status]}${paused ? ', actions paused' : ''}`
  return (
    <span className={`conn conn-${status}`} role="status" aria-live="polite" aria-label={label} title={label}>
      {status !== 'live' && <span aria-hidden="true">{LABELS[status]}</span>}
      <span className="conn-dot" aria-hidden="true" />
    </span>
  )
}
