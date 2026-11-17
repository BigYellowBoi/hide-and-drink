import type { SyncStatus } from './engine'

export interface Lockout {
  /** Short headline for the banner. */
  title: string
  detail: string
  /** Seconds out of date, if we were live before; null on first load. */
  staleForS: number | null
}

/** Statuses that block actions but are expected to recover on their own. */
const LOCKED: Partial<Record<SyncStatus, Omit<Lockout, 'staleForS'>>> = {
  offline: {
    title: 'No connection',
    detail: 'Actions are locked so nothing is sent from an old view. They unlock once you are back online and caught up.',
  },
  connecting: {
    title: 'Reconnecting…',
    detail: 'Actions are locked until this phone is back in sync.',
  },
  syncing: {
    title: 'Catching up…',
    detail: 'Fetching what you missed. Actions unlock in a moment.',
  },
}

/**
 * The stale-state banner for a sync status, or null when actions are allowed (live) or the
 * screen shows its own message (idle, error).
 */
export function lockoutFor(status: SyncStatus, staleSince: number | null, now: number): Lockout | null {
  const base = LOCKED[status]
  if (!base) return null
  return { ...base, staleForS: staleSince === null ? null : Math.max(0, Math.floor((now - staleSince) / 1000)) }
}

/** Brief syncs (e.g. every app reopen) shouldn't flash a banner; offline shows at once. */
export const bannerDelayMs = (status: SyncStatus): number => (status === 'offline' ? 0 : 600)

export const formatStaleFor = (s: number): string =>
  s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`
