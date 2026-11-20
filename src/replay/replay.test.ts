import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { buildReplay, roundAt, stepAt, trackAt } from './state'
import { gameSummary, zipMediaPath } from './summary'
import { gameTeams, gameWinner, playtestLabel, storageLabel } from './pastGames'
import { eventsJson, zipName } from './download'
import type { PastGame, ReplayData, TrackPoint } from './api'

const T0 = Date.UTC(2026, 11, 1, 9, 0, 0)
const iso = (min: number) => new Date(T0 + min * 60_000).toISOString()
let seq = 0
const ev = (type: string, payload: Record<string, unknown>, min: number, visibility: GameEvent['visibility'] = 'all', actor: string | null = null): GameEvent => {
  seq += 1
  return { game_id: 'g', seq, type, visibility, actor_id: actor, payload, created_at: iso(min) }
}
const A = { user_id: 'a', name: 'Amy' }
const S = { user_id: 's', name: 'Sam' }
const score = (round: number, hiders: unknown[], seekers: unknown[], hide_s: number) => ({
  round, hiders, seekers, hide_s, bonus_s: 0, adjust_s: 0, total_s: hide_s, voided: false, seeking_at: iso(30), ended_at: iso(70),
})

function game(): GameEvent[] {
  seq = 0
  return [
    ev('game_created', { host_id: 's', code: 'ABCD', city: 'brisbane' }, 0),
    ev('player_joined', { user_id: 's', name: 'Sam' }, 0),
    ev('player_joined', { user_id: 'a', name: 'Amy' }, 0),
    ev('game_started', {
      round: 1, started_at: iso(0), hiding_period_s: 1800, play_area: { name: 'CBD' },
      players: [{ ...A, team: 'hiders' }, { ...S, team: 'seekers' }],
    }, 0),
    ev('bar_chosen', { round: 1, venue_id: 'v1', name: 'The Bar', lng: 153.02, lat: -27.47, radius_m: 100 }, 10, 'hiders'),
    ev('seeking_started', { round: 1, at: iso(30) }, 30),
    ev('question_asked', {
      question_id: 'q1', round: 1, type: 'radar', option_id: 'r1', prompt: 'Are you within 1 km of me?', params: { label: '1 km', center: [153, -27.4], distance_m: 1000 },
      asked_by: 's', asked_at: iso(35), deadline_at: iso(40), reward: { draw: 2, pick: 1 },
    }, 35),
    ev('question_answered', { question_id: 'q1', round: 1, answer: 'no', answered_at: iso(37) }, 37),
    ev('round_ended', { round: 1, score: score(1, [A], [S], 2400), bar: { name: 'The Bar', lng: 153.02, lat: -27.47 } }, 70, 'all', 's'),
    ev('team_changed', { user_id: 'a', team: 'seekers' }, 70),
    ev('team_changed', { user_id: 's', team: 'hiders' }, 70),
    ev('game_ended', { reason: 'host', winners: ['a'], rounds: [score(1, [A], [S], 2400)], players: [{ ...A, total_s: 2400, rounds: 1 }], at: iso(75) }, 75),
  ]
}

const data = (events: GameEvent[], track: TrackPoint[] = []): ReplayData => ({
  game: { id: 'g', code: 'ABCD', city: 'brisbane', host_id: 's', created_at: iso(0), ended_at: iso(75) },
  can_delete: false,
  players: [{ ...A, team: 'seekers', is_host: false }, { ...S, team: 'hiders', is_host: true }],
  events,
  track,
  media: [],
})

describe('replay', () => {
  it('steps through every round in order, hider-only events included', () => {
    const r = buildReplay(game())
    expect(r.rounds).toHaveLength(1)
    expect(r.rounds[0].hiders).toEqual(['a'])
    expect(r.rounds[0].bar?.name).toBe('The Bar')
    expect(r.steps.map((s) => (s.kind === 'item' ? `${s.item.kind}:${s.item.kind === 'entry' ? s.item.entry.text : ''}` : s.kind))).toEqual([
      'round',
      'entry:Locked in The Bar',
      'entry:Seeking started',
      'question:',
      'entry:Found! Round 1 over',
      'end',
    ])
    const at = r.steps.map((s) => s.at)
    expect([...at].sort((x, y) => x - y)).toEqual(at)
    expect(r.start).toBe(T0)
    expect(r.end).toBe(T0 + 75 * 60_000)
  })

  it('finds the step and round showing at a time', () => {
    const r = buildReplay(game())
    expect(stepAt(r.steps, T0 - 1)).toBe(-1)
    expect(stepAt(r.steps, T0 + 36 * 60_000)).toBe(3)
    expect(roundAt(r, T0 + 36 * 60_000)?.round).toBe(1)
  })

  it('draws each player\'s path up to a time, for that round only', () => {
    const p = (user: string, team: 'hiders' | 'seekers', round: number, min: number, lng: number): TrackPoint => ({
      user_id: user, team, round, lng, lat: -27.4, accuracy_m: 5, at: iso(min),
    })
    const track = [p('a', 'hiders', 1, 1, 153.0), p('a', 'hiders', 1, 5, 153.01), p('s', 'seekers', 1, 38, 153.1), p('a', 'hiders', 1, 50, 153.02), p('a', 'seekers', 2, 80, 152)]
    const v = trackAt(track, 1, T0 + 40 * 60_000, (id) => (id === 'a' ? 'Amy' : 'Sam'))
    expect(v.paths).toEqual([
      { id: 'a', team: 'hiders', coords: [[153.0, -27.4], [153.01, -27.4]] },
      { id: 's', team: 'seekers', coords: [[153.1, -27.4]] },
    ])
    expect(v.dots.map((d) => [d.id, d.lng, d.name, d.stale])).toEqual([
      ['a', 153.01, 'Amy', true],
      ['s', 153.1, 'Sam', false],
    ])
  })

  it('writes a readable summary and the zip file names', () => {
    const events = game()
    const text = gameSummary(data(events), buildReplay(events), 'Australia/Brisbane')
    expect(text).toContain('Code ABCD · Brisbane · CBD')
    expect(text).toContain('Winner: Amy')
    expect(text).toContain('Hiders: Amy')
    expect(text).toContain('Hid at: The Bar')
    expect(text).toContain('Score: ')
    expect(text).toMatch(/\+5:00 {2}Radar: .+ \(asked by Sam\)/)
    expect(text).toContain('Answer: No')
    expect(text).toContain('Locked in The Bar (hiders only)')
    expect(zipMediaPath('g/q/a.jpg')).toBe('media/g/q/a.jpg')
    expect(zipName(data(events))).toBe('hide-and-drink-2026-12-01-ABCD.zip')
    expect(JSON.parse(eventsJson(data(events))).events).toHaveLength(events.length)
  })
})

describe('past games', () => {
  const g: PastGame = {
    id: 'g', city: 'brisbane', started_at: iso(0), ended_at: iso(75), play_area: 'CBD',
    players: [{ ...A, team: 'seekers' }, { ...S, team: 'hiders' }],
    rounds: [{ round: 1, hiders: [A], seekers: [S], bar_name: 'The Bar', total_s: 2400, voided: false }],
    winners: ['a'], totals: [{ ...A, total_s: 2400, rounds: 1 }, { ...S, total_s: 0, rounds: 0 }], mine: true, can_delete: false, playtest: false, expires_at: null,
  }
  it('shows the first round\'s teams and the winner', () => {
    expect(gameTeams(g)).toEqual({ hiders: 'Amy', seekers: 'Sam' })
    expect(gameTeams({ ...g, rounds: [] })).toEqual({ hiders: 'Sam', seekers: 'Amy' })
    expect(gameWinner(g)).toEqual({ names: 'Amy', totalS: 2400 })
    expect(gameWinner({ ...g, winners: [] })).toBeNull()
  })
  it('tags playtest games and when they go', () => {
    expect(playtestLabel(g)).toBeNull()
    expect(playtestLabel({ ...g, playtest: true })).toBe('Playtest')
    expect(playtestLabel({ ...g, playtest: true, expires_at: iso(60) })).toMatch(/^Playtest · deleted \w{3} \d{1,2}:\d{2}\s?[ap]m$/i)
  })
  it('shows storage used out of the free tier', () => {
    expect(storageLabel(1_234_000_000, 10_000_000_000)).toBe('1.2 GB of 10 GB free tier used (12%)')
    expect(storageLabel(45_000_000, 10_000_000_000)).toBe('45 MB of 10 GB free tier used (0%)')
  })
})
