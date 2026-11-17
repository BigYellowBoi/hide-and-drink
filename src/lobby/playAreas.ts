import type { SupabaseClient } from '@supabase/supabase-js'
import { asAreaCollection, type AreaCollection } from '../map/playArea'
import { callWithRetry } from '../sync/actions'
import type { SyncTransport } from '../sync/transport'

export interface PlayAreaSummary {
  id: string
  name: string
  city: string
  /** null for built-in (seeded) areas, which can't be overwritten or deleted. */
  createdBy: string | null
  /** Player name of whoever saved it, if known. */
  creatorName: string | null
  /** ms since epoch */
  createdAt: number
  area: AreaCollection | null
}

interface Row {
  id: string
  name: string
  city: string
  created_by: string | null
  creator_name: string | null
  created_at: string
  geojson: unknown
}

const toSummary = (r: Row): PlayAreaSummary => ({
  id: r.id,
  name: r.name,
  city: r.city,
  createdBy: r.created_by,
  creatorName: r.creator_name,
  createdAt: Date.parse(r.created_at),
  area: asAreaCollection(r.geojson),
})

/** Saved play areas, for one city or all. The polygon used in play is snapshotted at start. */
export async function listPlayAreas(client: SupabaseClient, city?: string): Promise<PlayAreaSummary[]> {
  let q = client.from('play_areas').select('id, name, city, created_by, creator_name, created_at, geojson')
  if (city) q = q.eq('city', city)
  const { data, error } = await q.order('city').order('name')
  if (error) throw new Error(error.message)
  return ((data ?? []) as Row[]).map(toSummary)
}

/** Delete a player-made area (server refuses built-ins and areas an open lobby has chosen). */
export async function deletePlayArea(transport: SyncTransport, id: string): Promise<void> {
  await transport.signIn()
  await callWithRetry(transport, 'delete_play_area', {
    p_play_area_id: id,
    p_client_action_id: crypto.randomUUID(),
  })
}

export const isBuiltIn = (a: PlayAreaSummary) => a.createdBy === null

const dayMonth = (ms: number) =>
  new Date(ms).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' })

/** "Built in", or "Amy · 17 Nov" for a player-made area. */
export function madeBy(a: PlayAreaSummary): string {
  if (isBuiltIn(a)) return 'Built in'
  const date = Number.isNaN(a.createdAt) ? '' : dayMonth(a.createdAt)
  return [a.creatorName ?? 'Someone', date].filter(Boolean).join(' · ')
}
