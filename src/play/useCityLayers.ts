import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { noVenueEdits, withVenueEdits, type VenueEdits } from '../venues/state'
import { layerLookup, type LayerLookup } from './features'

/**
 * City pack features by layer (cached per session), for matching, tentacles and count rules.
 * The game's venue edits apply: hidden venues drop out, custom ones count like any other.
 */
export function useCityLayers(city: string, venues: VenueEdits = noVenueEdits): LayerLookup | null {
  const [pack, setPack] = useState<CityPack | null>(null)
  useEffect(() => {
    if (!supabase) return
    let live = true
    loadCityPack(supabase, city)
      .then((p) => live && setPack(p))
      .catch(() => {
        /* the map shows load errors */
      })
    return () => {
      live = false
    }
  }, [city])
  return useMemo(() => (pack ? layerLookup(withVenueEdits(pack.features, venues)) : null), [pack, venues])
}
