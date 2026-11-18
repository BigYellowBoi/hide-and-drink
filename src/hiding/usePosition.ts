import { useCallback, useState } from 'react'
import { readLocal, writeLocal } from '../lib/storage'
import { fakeFix, fakePositionKey, parseFakeFix, serializeFakeFix } from './devPosition'
import { useGeolocation, type Fix, type GeoError } from './useGeolocation'

export interface Position {
  fix: Fix | null
  error: GeoError | null
  /** Dev/playtest mode: the fix is a point set by long-pressing the map, GPS is off. */
  dev: boolean
  /** Long-press handler for maps; only set in dev mode. */
  place: ((lngLat: [number, number]) => void) | undefined
}

/**
 * This phone's position: real GPS, or in dev/playtest mode a point placed by long-pressing the
 * map (kept on this phone across reloads). Every position-based feature reads it from here.
 */
export function usePosition(dev: boolean, gameId: string, userId: string | null): Position {
  const key = fakePositionKey(gameId, userId)
  const gps = useGeolocation(!dev)
  const [fake, setFake] = useState<{ key: string; fix: Fix | null }>(() => ({ key, fix: parseFakeFix(readLocal(key)) }))
  // Another game or player on this phone: read that one's point instead.
  const current = fake.key === key ? fake.fix : parseFakeFix(readLocal(key))
  const place = useCallback(
    ([lng, lat]: [number, number]) => {
      const fix = fakeFix(lng, lat, Date.now())
      writeLocal(key, serializeFakeFix(fix))
      setFake({ key, fix })
    },
    [key],
  )
  if (!dev) return { fix: gps.fix, error: gps.error, dev: false, place: undefined }
  return { fix: current, error: null, dev: true, place }
}
