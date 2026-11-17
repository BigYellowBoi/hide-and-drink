import { useEffect, useState } from 'react'
import type { LngLat } from './geo'

export interface Position {
  point: LngLat
  accuracyM: number
  at: number
}

/**
 * This phone's GPS while mounted. Stays on the phone: positions are never sent to the
 * server by this hook (seeker positions go into questions only when a seeker asks one).
 */
export function usePosition(enabled = true): { position: Position | null; error: string | null } {
  const [position, setPosition] = useState<Position | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!('geolocation' in navigator)) {
      // oxlint-disable-next-line react/set-state-in-effect
      setError('This device has no GPS.')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null)
        setPosition({ point: [p.coords.longitude, p.coords.latitude], accuracyM: p.coords.accuracy, at: p.timestamp })
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'Location is blocked for this site.' : 'No GPS fix yet.'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return { position, error }
}
