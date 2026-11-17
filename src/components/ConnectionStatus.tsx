import type { SyncStatus } from '../sync/engine'

const LABELS: Record<SyncStatus, string> = {
  idle: 'Not connected',
  connecting: 'Connecting…',
  syncing: 'Syncing…',
  live: 'Live',
  offline: 'Offline',
  error: 'Error',
}

/** Live/offline dot. Anything but green means actions are paused. */
export function ConnectionStatus({ status, canAct }: { status: SyncStatus; canAct: boolean }) {
  return (
    <span className={`conn conn-${status}`} role="status" aria-live="polite">
      <span className="conn-dot" aria-hidden="true" />
      {LABELS[status]}
      {!canAct && status !== 'idle' && <span className="conn-note"> · actions paused</span>}
    </span>
  )
}
