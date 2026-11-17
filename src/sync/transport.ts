import type { GameEvent, Team } from './types'

export type ChannelState = 'subscribed' | 'error' | 'closed'

/** Presence on a topic: who has the app open. Ephemeral, never game state. */
export interface PresenceOptions {
  /** This device's presence key (the user id), so one player counts once across tabs. */
  key: string
  /** Called with every key currently present whenever presence changes. */
  onSync: (keys: string[]) => void
}

export type ActionResult =
  | { ok: true; data: unknown }
  /** retryable: the request may not have reached the server (network, 5xx). */
  | { ok: false; code: string; message: string; retryable: boolean }

/** Everything the sync engine needs from the backend. Supabase in the app, fakes in tests. */
export interface SyncTransport {
  /** Signed-in user id (signs in anonymously if needed). */
  signIn(): Promise<string>
  /** The caller's player row in this game, or null if not a player. */
  membership(gameId: string): Promise<{ team: Team | null } | null>
  /** Every event the caller can see with seq > afterSeq, in seq order. */
  fetchEvents(gameId: string, afterSeq: number): Promise<GameEvent[]>
  /** Server clock in ms since epoch. */
  serverTime(): Promise<number>
  /** Join a private topic, optionally tracking presence on it. Returns an unsubscribe function. */
  subscribe(
    topic: string,
    onEvent: (raw: unknown) => void,
    onState: (state: ChannelState) => void,
    presence?: PresenceOptions,
  ): () => void
  /** Call a game action database function. */
  call(fn: string, args: Record<string, unknown>): Promise<ActionResult>
}

export const gameTopic = (gameId: string) => `game:${gameId}`
export const teamTopic = (gameId: string, team: Team) => `game:${gameId}:${team}`
