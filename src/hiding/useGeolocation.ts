import { useEffect, useState } from 'react'

export interface Fix {
  lng: number
  lat: number
  accuracyM: number | null
  /** Device time of the fix, ms. */
  at: number
  /** Dev/playtest mode: placed by long-pressing the map, not from GPS. */
  fake?: boolean
}

export type GeoError = 'denied' | 'unavailable' | 'unsupported'

/** Watch this phone's GPS while enabled. The fix stays on the device unless the caller sends it. */
export function useGeolocation(enabled: boolean): { fix: Fix | null; error: GeoError | null } {
  const [fix, setFix] = useState<Fix | null>(null)
  const [error, setError] = useState<GeoError | null>(null)

  useEffect(() => {
    if (!enabled) return
    if (!('geolocation' in navigator)) {
      // oxlint-disable-next-line react/set-state-in-effect
      setError('unsupported')
      return
    }
    const id = navigator.geolocation.watchPosition(
      (p) => {
        setError(null)
        setFix({
          lng: p.coords.longitude,
          lat: p.coords.latitude,
          accuracyM: Number.isFinite(p.coords.accuracy) ? p.coords.accuracy : null,
          at: p.timestamp,
        })
      },
      (e) => setError(e.code === e.PERMISSION_DENIED ? 'denied' : 'unavailable'),
      { enableHighAccuracy: true, maximumAge: 10_000, timeout: 30_000 },
    )
    return () => navigator.geolocation.clearWatch(id)
  }, [enabled])

  return { fix: enabled ? fix : null, error: enabled ? error : null }
}
