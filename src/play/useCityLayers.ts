import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import { loadCityPack } from '../map/cityPack'
import { layerLookup, type LayerLookup } from './features'

/** City pack features by layer (cached per session), for matching, tentacles and count rules. */
export function useCityLayers(city: string): LayerLookup | null {
  const [layer, setLayer] = useState<LayerLookup | null>(null)
  useEffect(() => {
    if (!supabase) return
    let live = true
    loadCityPack(supabase, city)
      .then((pack) => live && setLayer(() => layerLookup(pack.features)))
      .catch(() => {
        /* the map shows load errors */
      })
    return () => {
      live = false
    }
  }, [city])
  return layer
}
