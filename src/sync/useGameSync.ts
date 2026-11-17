import { useEffect, useState, useSyncExternalStore } from 'react'
import { GameSync, type SyncSnapshot } from './engine'
import type { SyncTransport } from './transport'

const idle: SyncSnapshot = {
  status: 'idle',
  canAct: false,
  lastSeq: 0,
  events: [],
  team: null,
  userId: null,
  clockOffsetMs: 0,
  error: null,
  present: [],
  staleSince: null,
}
const noop = () => () => {}
const getIdle = () => idle

/** Sync one game for the lifetime of the component. Wires up visibility and network events. */
export function useGameSync(gameId: string | null, transport: SyncTransport | null) {
  const [sync, setSync] = useState<GameSync | null>(null)

  useEffect(() => {
    if (!gameId || !transport) return
    const s = new GameSync(gameId, transport)
    const onVisibility = () => s.setVisible(document.visibilityState === 'visible')
    const onOnline = () => s.setOnline(true)
    const onOffline = () => s.setOnline(false)
    // pageshow covers iOS restoring a home-screen PWA from the back/forward cache.
    const onPageShow = (e: PageTransitionEvent) => e.persisted && s.setVisible(true)
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    window.addEventListener('pageshow', onPageShow)
    if (!navigator.onLine) s.setOnline(false)
    // The engine is the external system; React only needs a handle to read its store.
    // oxlint-disable-next-line react/set-state-in-effect
    setSync(s)
    void s.start()
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('pageshow', onPageShow)
      s.stop()
      setSync((cur) => (cur === s ? null : cur))
    }
  }, [gameId, transport])

  const snapshot = useSyncExternalStore(sync?.subscribe ?? noop, sync?.getSnapshot ?? getIdle)
  return { sync, ...snapshot }
}
