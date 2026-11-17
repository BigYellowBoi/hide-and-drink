import type { SupabaseClient } from '@supabase/supabase-js'

export interface PlayAreaSummary {
  id: string
  name: string
}

/** Saved play areas for a city (names only; the polygon is snapshotted server-side at start). */
export async function listPlayAreas(client: SupabaseClient, city: string): Promise<PlayAreaSummary[]> {
  const { data, error } = await client.from('play_areas').select('id, name').eq('city', city).order('name')
  if (error) throw new Error(error.message)
  return (data ?? []) as PlayAreaSummary[]
}
