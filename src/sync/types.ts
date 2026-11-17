export type Team = 'hiders' | 'seekers'
export type Visibility = 'all' | Team

/** Who is looking at the event log: a player with no team yet sees only 'all' events. */
export type Audience = 'none' | Team

export const audienceFor = (team: Team | null): Audience => team ?? 'none'

/** One row of the append-only event log, as read from the table or received by broadcast. */
export interface GameEvent {
  game_id: string
  seq: number
  type: string
  visibility: Visibility
  actor_id: string | null
  payload: Record<string, unknown>
  created_at: string
  /**
   * Broadcasts only: per audience, the seq of the previous event that audience can see.
   * seq is contiguous per game across all visibilities, so each team skips the other's seqs.
   */
  prev_seq?: Partial<Record<Audience, number>>
}

export function isGameEvent(value: unknown): value is GameEvent {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.game_id === 'string' &&
    typeof v.seq === 'number' &&
    Number.isInteger(v.seq) &&
    v.seq >= 1 &&
    typeof v.type === 'string'
  )
}

/** A seeker's latest GPS fix. Ephemeral: broadcast to seekers only, never in the event log. */
export interface SeekerPosition {
  userId: string
  round: number
  lng: number
  lat: number
  accuracyM: number | null
  /** Server time the report arrived, ms since epoch. */
  at: number
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** A 'position' broadcast or seeker_positions row (snake_case), or null if malformed. */
export function parsePosition(raw: unknown): SeekerPosition | null {
  if (typeof raw !== 'object' || raw === null) return null
  const v = raw as Record<string, unknown>
  const userId = v.user_id
  const lng = num(v.lng)
  const lat = num(v.lat)
  const round = num(v.round)
  const at = Date.parse(String(v.at ?? v.reported_at ?? ''))
  if (typeof userId !== 'string' || lng === null || lat === null || round === null || Number.isNaN(at)) return null
  return { userId, round, lng, lat, accuracyM: num(v.accuracy_m), at }
}
