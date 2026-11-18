import { lazy, type ComponentType } from 'react'

/**
 * Lazy chunks can vanish under a running app: the service worker updates as soon as a new
 * version is deployed and deletes the old version's cached files, but an open page (iOS keeps
 * home-screen apps alive for days) still asks for the old file names. Loading one then fails
 * and, without this, React unmounts the whole app (blank navy screen).
 *
 * Fix: reload once to pick up the new version. Game state comes back from the server, so a
 * reload loses nothing. At most one reload per 30 s, so a real outage can't loop.
 */
const KEY = 'hd.chunkReloadAt'
const WINDOW_MS = 30_000

/** Reload for a new version. False (no reload) if one was just tried. */
export function reloadForNewVersion(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY))
    if (last && now - last < WINDOW_MS) return false
    sessionStorage.setItem(KEY, String(now))
  } catch {
    // No storage: still reload once; the next failure in this page falls through to the error screen.
    if (reloaded) return false
  }
  reloaded = true
  location.reload()
  return true
}
let reloaded = false

/** React.lazy that reloads the page instead of crashing when the chunk is gone. */
// Same constraint as React.lazy's own signature.
// oxlint-disable-next-line typescript/no-explicit-any
export function lazyWithReload<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() =>
    load().catch((e: unknown) => {
      // Keep showing the Suspense fallback until the reload happens.
      if (reloadForNewVersion()) return new Promise<{ default: T }>(() => {})
      throw e
    }),
  )
}
