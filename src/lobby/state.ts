import type { GameEvent, Team } from '../sync/types'

export interface LobbyPlayer {
  userId: string
  name: string
  team: Team | null
  isHost: boolean
}

export interface StartedRound {
  round: number
  /** Server time, ms since epoch. */
  startedAt: number
  hidingPeriodS: number
  playAreaName: string | null
}

export type GameStatus = 'lobby' | 'hiding' | 'seeking' | 'ended'

export interface LobbyState {
  code: string | null
  city: string
  hostId: string | null
  config: Record<string, unknown>
  playAreaId: string | null
  playAreaName: string | null
  players: LobbyPlayer[]
  status: GameStatus
  started: StartedRound | null
}

export const emptyLobby: LobbyState = {
  code: null,
  city: 'brisbane',
  hostId: null,
  config: {},
  playAreaId: null,
  playAreaName: null,
  players: [],
  status: 'lobby',
  started: null,
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const asTeam = (v: unknown): Team | null => (v === 'hiders' || v === 'seekers' ? v : null)

function upsertPlayer(players: LobbyPlayer[], p: LobbyPlayer): LobbyPlayer[] {
  const i = players.findIndex((x) => x.userId === p.userId)
  if (i === -1) return [...players, p]
  const next = [...players]
  next[i] = { ...next[i], ...p }
  return next
}

/** Apply one event. Unknown event types are ignored, so later phases can add their own. */
export function applyLobbyEvent(state: LobbyState, e: GameEvent): LobbyState {
  const p = e.payload
  switch (e.type) {
    case 'game_created': {
      const hostId = str(p.host_id)
      return {
        ...state,
        code: str(p.code),
        city: str(p.city) ?? state.city,
        hostId,
        config: isObject(p.config) ? p.config : state.config,
        players: hostId
          ? upsertPlayer(state.players, { userId: hostId, name: str(p.host_name) ?? 'Host', team: null, isHost: true })
          : state.players,
      }
    }
    case 'player_joined': {
      const userId = str(p.user_id)
      if (!userId) return state
      return {
        ...state,
        players: upsertPlayer(state.players, {
          userId,
          name: str(p.name) ?? 'Player',
          team: null,
          isHost: userId === state.hostId,
        }),
      }
    }
    case 'team_changed': {
      const userId = str(p.user_id)
      return {
        ...state,
        players: state.players.map((x) => (x.userId === userId ? { ...x, team: asTeam(p.team) } : x)),
      }
    }
    case 'config_changed':
      return isObject(p.config) ? { ...state, config: p.config } : state
    case 'play_area_changed':
      return { ...state, playAreaId: str(p.play_area_id), playAreaName: str(p.name) }
    case 'game_started': {
      const area = isObject(p.play_area) ? p.play_area : {}
      const startedAt = Date.parse(str(p.started_at) ?? '')
      let players = state.players
      if (Array.isArray(p.players)) {
        for (const raw of p.players) {
          if (!isObject(raw) || !str(raw.user_id)) continue
          const userId = str(raw.user_id)!
          const existing = players.find((x) => x.userId === userId)
          players = upsertPlayer(players, {
            userId,
            name: str(raw.name) ?? existing?.name ?? 'Player',
            team: asTeam(raw.team),
            isHost: userId === state.hostId,
          })
        }
      }
      return {
        ...state,
        status: 'hiding',
        config: isObject(p.config) ? p.config : state.config,
        playAreaId: str(area.id) ?? state.playAreaId,
        playAreaName: str(area.name) ?? state.playAreaName,
        players,
        started: {
          round: typeof p.round === 'number' ? p.round : 1,
          startedAt: Number.isNaN(startedAt) ? Date.parse(e.created_at) : startedAt,
          hidingPeriodS: typeof p.hiding_period_s === 'number' ? p.hiding_period_s : 0,
          playAreaName: str(area.name),
        },
      }
    }
    default:
      return state
  }
}

export function deriveLobby(events: readonly GameEvent[]): LobbyState {
  return events.reduce(applyLobbyEvent, emptyLobby)
}

/** Why the host can't start yet. Mirrors the checks in start_game, in the same order. */
export type StartBlocker = 'players_without_team' | 'needs_both_teams' | 'play_area_required' | 'hiding_period_required'

export function startBlockers(state: LobbyState): StartBlocker[] {
  const out: StartBlocker[] = []
  if (state.players.some((p) => !p.team)) out.push('players_without_team')
  if (!state.players.some((p) => p.team === 'hiders') || !state.players.some((p) => p.team === 'seekers')) {
    out.push('needs_both_teams')
  }
  if (!state.playAreaId) out.push('play_area_required')
  const h = state.config.hiding_period_s
  if (typeof h !== 'number' || h <= 0 || !Number.isInteger(h)) out.push('hiding_period_required')
  return out
}
