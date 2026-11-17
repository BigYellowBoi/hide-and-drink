import type { SupabaseClient } from '@supabase/supabase-js'
import type { Feature, FeatureCollection, Geometry } from 'geojson'

export interface PackSource {
  name: string
  licence?: string
}

export interface CityPack extends FeatureCollection<Geometry, PackProps> {
  pack: {
    city: string
    label: string
    extent: Geometry
    sources?: PackSource[]
  }
}

export interface PackProps {
  layer: string
  name: string
  [key: string]: unknown
}

const cache = new Map<string, Promise<CityPack>>()

/** The city's map data (get_city_pack), fetched once per app session. */
export function loadCityPack(client: SupabaseClient, city: string): Promise<CityPack> {
  let p = cache.get(city)
  if (!p) {
    p = (async () => {
      const { data, error } = await client.rpc('get_city_pack', { p_city: city })
      if (error) throw new Error(error.message)
      if (!data) throw new Error(`No map data for ${city} yet.`)
      return data as CityPack
    })()
    cache.set(city, p)
    p.catch(() => cache.delete(city)) // let a later mount retry
  }
  return p
}

/** Features of some layers as one collection, for a MapLibre source. */
export function layerCollection(pack: CityPack, layers: string[]): FeatureCollection<Geometry, PackProps> {
  const want = new Set(layers)
  return { type: 'FeatureCollection', features: pack.features.filter((f: Feature<Geometry, PackProps>) => want.has(f.properties.layer)) }
}
