import { useCallback, useEffect, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { SyncTransport } from '../sync/transport'
import { fetchLibrary, type Library } from './library'

export const LIBRARY_TOPIC = 'library'

/**
 * The card library, kept live: refetched whenever the server broadcasts a change on the
 * 'library' topic, when the channel (re)connects, and when the app comes back to the front.
 * The library is small (tens of cards), so a full refetch is simpler than patching.
 */
export function useLibrary(transport: SyncTransport | null) {
  const [library, setLibrary] = useState<Library | null>(null)
  const [error, setError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const alive = useRef(true)

  const reload = useCallback(async () => {
    if (!supabase) return
    try {
      const lib = await fetchLibrary(supabase)
      if (alive.current) {
        setLibrary(lib)
        setError(null)
      }
    } catch (e) {
      if (alive.current) setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  const soon = useCallback(() => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => void reload(), 150)
  }, [reload])

  useEffect(() => {
    alive.current = true
    if (!transport) return
    let unsubscribe: (() => void) | null = null
    let stopped = false
    transport
      .signIn()
      .then(() => {
        if (stopped) return
        unsubscribe = transport.subscribe(
          LIBRARY_TOPIC,
          () => soon(),
          (state) => state === 'subscribed' && soon(),
        )
        void reload()
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))

    const onVisible = () => document.visibilityState === 'visible' && soon()
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', soon)
    return () => {
      stopped = true
      alive.current = false
      unsubscribe?.()
      if (timer.current) clearTimeout(timer.current)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', soon)
    }
  }, [transport, reload, soon])

  return { library, error, reload }
}
