import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { deriveLobby, startBlockers } from './state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility: 'all',
  actor_id: null,
  payload,
  created_at: '2026-11-17T10:00:00Z',
})

const lobbyEvents = () => [
  ev('game_created', { code: 'ABCD', city: 'brisbane', host_id: 'h', host_name: 'Hana', config: { hiding_period_s: null } }),
  ev('player_joined', { user_id: 'a', name: 'Amy' }),
  ev('player_joined', { user_id: 's', name: 'Sam' }),
]

describe('deriveLobby', () => {
  it('builds players, host and config from the log', () => {
    const s = deriveLobby(lobbyEvents())
    expect(s.code).toBe('ABCD')
    expect(s.hostId).toBe('h')
    expect(s.players.map((p) => [p.name, p.isHost, p.team])).toEqual([
      ['Hana', true, null],
      ['Amy', false, null],
      ['Sam', false, null],
    ])
    expect(s.config).toEqual({ hiding_period_s: null })
    expect(s.status).toBe('lobby')
  })

  it('applies team changes, config and play area', () => {
    const s = deriveLobby([
      ...lobbyEvents(),
      ev('team_changed', { user_id: 'a', team: 'hiders' }),
      ev('team_changed', { user_id: 'a', team: 'seekers' }),
      ev('config_changed', { config: { hiding_period_s: 1800 } }),
      ev('play_area_changed', { play_area_id: 'p1', name: 'Inner' }),
    ])
    expect(s.players.find((p) => p.userId === 'a')?.team).toBe('seekers')
    expect(s.config.hiding_period_s).toBe(1800)
    expect(s.playAreaName).toBe('Inner')
  })

  it('drops players who leave and hands the host over', () => {
    const s = deriveLobby([...lobbyEvents(), ev('player_left', { user_id: 'h', name: 'Hana', new_host_id: 'a' })])
    expect(s.hostId).toBe('a')
    expect(s.players.map((p) => [p.name, p.isHost])).toEqual([
      ['Amy', true],
      ['Sam', false],
    ])
    const t = deriveLobby([...lobbyEvents(), ev('player_left', { user_id: 's', name: 'Sam', new_host_id: null })])
    expect(t.hostId).toBe('h')
    expect(t.players.map((p) => p.name)).toEqual(['Hana', 'Amy'])
  })

  it('drops removed players', () => {
    const s = deriveLobby([...lobbyEvents(), ev('player_removed', { user_id: 'a', name: 'Amy' })])
    expect(s.players.map((p) => p.name)).toEqual(['Hana', 'Sam'])
  })

  it('records the start and the locked teams', () => {
    const s = deriveLobby([
      ...lobbyEvents(),
      ev('game_started', {
        round: 1,
        started_at: '2026-11-17T10:05:00Z',
        hiding_period_s: 1800,
        config: { hiding_period_s: 1800 },
        play_area: {
          id: 'p1',
          name: 'Inner',
          geojson: { type: 'Polygon', coordinates: [[[153, -27], [153.1, -27], [153.1, -27.1], [153, -27]]] },
        },
        players: [
          { user_id: 'h', name: 'Hana', team: 'hiders' },
          { user_id: 'a', name: 'Amy', team: 'hiders' },
          { user_id: 's', name: 'Sam', team: 'seekers' },
        ],
      }),
    ])
    expect(s.status).toBe('hiding')
    expect(s.started).toEqual({
      round: 1,
      startedAt: Date.parse('2026-11-17T10:05:00Z'),
      hidingPeriodS: 1800,
      playAreaName: 'Inner',
      playArea: {
        type: 'FeatureCollection',
        features: [
          {
            type: 'Feature',
            properties: {},
            geometry: { type: 'Polygon', coordinates: [[[153, -27], [153.1, -27], [153.1, -27.1], [153, -27]]] },
          },
        ],
      },
    })
    expect(s.players.map((p) => p.team)).toEqual(['hiders', 'hiders', 'seekers'])
  })

  it('ignores unknown events', () => {
    expect(deriveLobby([...lobbyEvents(), ev('something_new', {})])).toEqual(deriveLobby(lobbyEvents()))
  })
})

describe('startBlockers', () => {
  it('lists everything missing, then nothing once ready', () => {
    const base = deriveLobby(lobbyEvents())
    expect(startBlockers(base)).toEqual([
      'players_without_team',
      'needs_both_teams',
      'play_area_required',
      'hiding_period_required',
    ])
    const ready = deriveLobby([
      ...lobbyEvents(),
      ev('team_changed', { user_id: 'h', team: 'hiders' }),
      ev('team_changed', { user_id: 'a', team: 'hiders' }),
      ev('team_changed', { user_id: 's', team: 'seekers' }),
      ev('play_area_changed', { play_area_id: 'p1', name: 'Inner' }),
      ev('config_changed', { config: { hiding_period_s: 1800 } }),
    ])
    expect(startBlockers(ready)).toEqual([])
  })

  it('rejects a fractional hiding period like the server does', () => {
    const s = deriveLobby([...lobbyEvents(), ev('config_changed', { config: { hiding_period_s: 90.5 } })])
    expect(startBlockers(s)).toContain('hiding_period_required')
  })
})
