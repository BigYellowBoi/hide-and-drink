import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { barOptions, loadHidingBars } from '../hiding/bars'
import { loadCityPack } from '../map/cityPack'
import type { Venue } from './shading'

/** Bars the hider could have picked in this game (play area, station zone), for shading. */
export function useHidingVenues(city: string, gameId: string): Venue[] {
  const [venues, setVenues] = useState<Venue[]>([])
  useEffect(() => {
    if (!supabase) return
    let live = true
    Promise.all([loadCityPack(supabase, city), loadHidingBars(supabase, gameId)])
      .then(([pack, ids]) => {
        if (live) setVenues(barOptions(pack, ids, null).map((b) => ({ id: b.id, name: b.name, point: [b.lng, b.lat] })))
      })
      .catch(() => {
        /* the map shows load errors */
      })
    return () => {
      live = false
    }
  }, [city, gameId])
  return venues
}
