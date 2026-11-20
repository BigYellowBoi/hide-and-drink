import { FunctionsFetchError, FunctionsHttpError, FunctionsRelayError, type SupabaseClient } from '@supabase/supabase-js'
import { ActionError } from '../sync/actions'
import type { GameEvent, Team } from '../sync/types'

/** One recorded position of a player (server-side track, readable only once the game has ended). */
export interface TrackPoint {
  user_id: string
  round: number
  team: Team
  lng: number
  lat: number
  accuracy_m: number | null
  at: string
}

/** A media file of the game: in R2 or in a Supabase bucket. */
export interface MediaFile {
  name: string
  store: 'r2' | 'supabase'
  bucket: string
  bytes: number | null
  content_type: string | null
}

export interface ReplayPlayer {
  user_id: string
  name: string
  team: Team | null
  is_host: boolean
}

/** Everything about an ended game (get_replay): both teams' events, every track, the media. */
export interface ReplayData {
  game: { id: string; code: string; city: string; host_id: string; created_at: string; ended_at: string | null }
  can_delete: boolean
  players: ReplayPlayer[]
  events: GameEvent[]
  track: TrackPoint[]
  media: MediaFile[]
}

export interface PastRoundRow {
  round: number
  hiders: { user_id: string; name: string }[]
  seekers: { user_id: string; name: string }[]
  bar_name: string | null
  total_s: number
  voided: boolean
}

/** A row of Home's past games list (list_past_games). */
export interface PastGame {
  id: string
  city: string
  started_at: string | null
  ended_at: string
  play_area: string | null
  players: { user_id: string; name: string; team: Team | null }[]
  rounds: PastRoundRow[]
  winners: string[]
  totals: { user_id: string; name: string; total_s: number; rounds: number }[]
  /** This user played in it (admins also see games they didn't). */
  mine: boolean
  can_delete: boolean
  /** Played in dev/playtest mode. */
  playtest: boolean
  /** A playtest game that will be deleted: listed until then (24 h after its last event). */
  expires_at: string | null
}

async function rpc<T>(client: SupabaseClient, fn: string, args?: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.rpc(fn, args)
  if (error) {
    const code = /^[a-z][a-z0-9_]{2,60}$/.test(error.message) ? error.message : 'function_unavailable'
    throw new ActionError(code, error.message)
  }
  return data as T
}

export const fetchReplay = (client: SupabaseClient, gameId: string) => rpc<ReplayData>(client, 'get_replay', { p_game_id: gameId })
export const listPastGames = async (client: SupabaseClient) => (await rpc<PastGame[] | null>(client, 'list_past_games')) ?? []
export const fetchIsAdmin = (client: SupabaseClient) => rpc<boolean>(client, 'is_admin')
export const fetchMediaUsage = (client: SupabaseClient) =>
  rpc<{ r2_bytes: number; r2_free_bytes: number }>(client, 'media_usage')

/** Call one of this feature's Edge Functions; its { error } code becomes an ActionError. */
async function invoke<T>(client: SupabaseClient, fn: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await client.functions.invoke(fn, { body })
  if (!error) return data as T
  if (error instanceof FunctionsHttpError) {
    const payload = (await (error.context as Response).json().catch(() => null)) as { error?: string } | null
    if (payload?.error) throw new ActionError(payload.error)
  }
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) throw new ActionError('function_unavailable')
  throw new ActionError('function_unavailable', error.message)
}

/** Check the admin PIN (Edge Function admin-pin); true once this user is an admin. */
export async function enterAdminPin(client: SupabaseClient, pin: string): Promise<boolean> {
  const res = await invoke<{ admin?: boolean }>(client, 'admin-pin', { pin })
  return res?.admin === true
}

/** Delete an ended game and all its media for everyone (Edge Function delete-game). */
export async function deleteGame(client: SupabaseClient, gameId: string): Promise<void> {
  await invoke(client, 'delete-game', { game_id: gameId, client_action_id: crypto.randomUUID() })
}
