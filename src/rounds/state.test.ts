import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { deriveRounds, formatDuration, scoredRounds, sides } from './state'
import { deriveLobby } from '../lobby/state'
import { effectiveEvents } from '../overrides/state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown> = {}): GameEvent => {
  seq += 1
  return { game_id: 'g', seq, type, visibility: 'all', actor_id: null, payload, created_at: new Date(Date.UTC(2026, 11, 1, 10, 0, seq)).toISOString() }
}
const A = { user_id: 'a', name: 'Amy' }
const B = { user_id: 'b', name: 'Ben' }
const S = { user_id: 's', name: 'Sam' }
const T = { user_id: 't', name: 'Tia' }
const score = (round: number, hiders: unknown[], seekers: unknown[], hide_s: number, extra: Record<string, unknown> = {}) => ({
  round,
  hiders,
  seekers,
  hide_s,
  bonus_s: 0,
  adjust_s: 0,
  total_s: hide_s + Number(extra.bonus_s ?? 0) + Number(extra.adjust_s ?? 0),
  voided: false,
  seeking_at: '2026-12-01T10:30:00Z',
  ended_at: '2026-12-01T11:10:00Z',
  ...extra,
})

describe('rounds and scores', () => {
  it('scores rounds, applies adjustments and redos, and groups the teams', () => {
    const events = [
      ev('round_ended', { round: 1, score: score(1, [A, B], [S, T], 2400, { bonus_s: 240 }), bar: { name: 'Test Bar', lng: 153, lat: -27 } }),
      ev('score_adjusted', { round: 1, seconds: -300, score: score(1, [A, B], [S, T], 2400, { bonus_s: 240, adjust_s: -300 }), override_id: 'o1' }),
      ev('round_ended', { round: 2, score: score(2, [S, T], [A, B], 3000) }),
      ev('round_ended', { round: 3, score: score(3, [A, B], [S, T], 100) }),
      ev('round_redone', { round: 3, score: score(3, [A, B], [S, T], 100, { voided: true }) }),
    ]
    const s = deriveRounds(events)
    expect(s.rounds.map((r) => [r.round, r.totalS, r.voided])).toEqual([
      [1, 2340, false],
      [2, 3000, false],
      [3, 100, true],
    ])
    expect(scoredRounds(s)).toHaveLength(2)
    expect(deriveRounds(events.slice(0, 1)).lastBar?.name).toBe('Test Bar')
    expect(s.lastBar).toBeNull()
    expect(sides(s).map((x) => [x.players.map((p) => p.name), x.rounds, x.totalS])).toEqual([
      [['Sam', 'Tia'], [2], 3000],
      [['Amy', 'Ben'], [1], 2340],
    ])
    // Undoing the adjustment drops its event.
    const undone = effectiveEvents([...events, ev('override_undone', { target_id: 'o1' })])
    expect(deriveRounds(undone).rounds[0].totalS).toBe(2640)
  })

  it('reads the final result and the status', () => {
    const events = [
      ev('round_ended', { round: 1, score: score(1, [A], [S], 600) }),
      ev('game_ended', { reason: 'host', winners: ['a'], rounds: [score(1, [A], [S], 600)], unfinished_round: null }),
    ]
    const s = deriveRounds(events)
    expect(s.result).toMatchObject({ reason: 'host', winners: ['a'], unfinishedRound: null })
    expect(deriveLobby(events).status).toBe('ended')
    expect(deriveLobby(events.slice(0, 1)).status).toBe('round_over')
    expect(deriveLobby([ev('game_ended', { reason: 'inactive', winners: [] })]).status).toBe('ended')
  })

  it('formats durations', () => {
    expect(formatDuration(3725)).toBe('1 h 02 min')
    expect(formatDuration(2830)).toBe('47 min 10 s')
    expect(formatDuration(600)).toBe('10 min')
    expect(formatDuration(-300)).toBe('−5 min')
    expect(formatDuration(42)).toBe('42 s')
  })
})
