import type { SupabaseClient } from '@supabase/supabase-js'
import type { Point } from 'geojson'
import type { CityPack } from '../map/cityPack'
import { distanceM, type LngLat } from '../map/geo'

export interface BarOption {
  id: string
  name: string
  kind: string | null
  lng: number
  lat: number
  /** From this phone, if it has a GPS fix. */
  distanceM: number | null
}

/** Venue ids the server accepts for choose_bar in this game (play area, station zone). */
export async function loadHidingBars(client: SupabaseClient, gameId: string): Promise<string[]> {
  const { data, error } = await client.rpc('hiding_bars', { p_game_id: gameId })
  if (error) throw new Error(error.message)
  return Array.isArray(data) ? data.filter((x): x is string => typeof x === 'string') : []
}

/** The valid venues from the city pack, nearest first (by name without a fix), filtered by a search. */
export function barOptions(pack: CityPack, validIds: readonly string[], from: LngLat | null, search = ''): BarOption[] {
  const valid = new Set(validIds)
  const q = search.trim().toLowerCase()
  const out: BarOption[] = []
  for (const f of pack.features) {
    const id = typeof f.id === 'string' ? f.id : null
    if (f.properties.layer !== 'venues' || !id || !valid.has(id) || f.geometry.type !== 'Point') continue
    const name = f.properties.name
    if (q && !name.toLowerCase().includes(q)) continue
    const [lng, lat] = (f.geometry as Point).coordinates
    out.push({
      id,
      name,
      kind: typeof f.properties.kind === 'string' ? f.properties.kind : null,
      lng,
      lat,
      distanceM: from ? distanceM(from, [lng, lat]) : null,
    })
  }
  return out.sort((a, b) =>
    a.distanceM !== null && b.distanceM !== null ? a.distanceM - b.distanceM : a.name.localeCompare(b.name),
  )
}
