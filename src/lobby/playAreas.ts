import type { SupabaseClient } from '@supabase/supabase-js'
import { asAreaCollection, type AreaCollection } from '../map/playArea'

export interface PlayAreaSummary {
  id: string
  name: string
  /** null for seeded areas; only the creator can overwrite an area. */
  createdBy: string | null
  area: AreaCollection | null
}

/** Saved play areas for a city. The polygon used in play is snapshotted server-side at start. */
export async function listPlayAreas(client: SupabaseClient, city: string): Promise<PlayAreaSummary[]> {
  const { data, error } = await client
    .from('play_areas')
    .select('id, name, created_by, geojson')
    .eq('city', city)
    .order('name')
  if (error) throw new Error(error.message)
  return (data ?? []).map((r: { id: string; name: string; created_by: string | null; geojson: unknown }) => ({
    id: r.id,
    name: r.name,
    createdBy: r.created_by,
    area: asAreaCollection(r.geojson),
  }))
}
