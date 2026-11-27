import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { deriveLobby } from '../lobby/state'
import { derivePlay, dueTimer, shadable } from '../play/state'
import { moveConstraint } from '../play/shading'
import { castBlocker, type CardDef } from '../cards/state'
import { deriveHiding, roundClock } from './state'
import { moveRunning, pausedMs } from './move'

let seq = 0
const T0 = Date.parse('2026-11-27T10:00:00Z')
const iso = (ms: number) => new Date(ms).toISOString()
const ev = (type: string, payload: Record<string, unknown>, at = T0, visibility: GameEvent['visibility'] = 'all'): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: null,
  payload,
  created_at: iso(at),
})

const MIN = 60_000
// Hiding 30 min from T0; seeking from T0 + 30 min; Move at +40 min for 10 min.
const started = ev('game_started', { round: 1, started_at: iso(T0), hiding_period_s: 1800, players: [] })
const seeking = ev('seeking_started', { round: 1, at: iso(T0 + 30 * MIN) }, T0 + 30 * MIN)
const moveStarted = (at = T0 + 40 * MIN) =>
  ev(
    'move_started',
    {
      round: 1,
      instance_id: 'm1',
      from: { name: 'The Pub', lng: 153.02, lat: -27.47 },
      radius_m: 1500,
      duration_s: 600,
      started_at: iso(at),
      ends_at: iso(at + 10 * MIN),
    },
    at,
  )

describe('Move period', () => {
  it('pauses the seeking clock for its length', () => {
    const lobby = deriveLobby([started, seeking, moveStarted()])
    const s = lobby.started!
    // 15 min into seeking, 5 of them in the Move: the clock shows 10.
    expect(roundClock(s.startedAt, s.hidingPeriodS, T0 + 45 * MIN, s.pauses)).toEqual({ phase: 'seeking', ms: 10 * MIN })
    // After it: 10 min paused.
    expect(roundClock(s.startedAt, s.hidingPeriodS, T0 + 60 * MIN, s.pauses).ms).toBe(20 * MIN)
  })

  it('stops pausing when a host fix ends it early', () => {
    const lobby = deriveLobby([started, seeking, moveStarted(), ev('move_cancelled', { round: 1 }, T0 + 42 * MIN)])
    const s = lobby.started!
    expect(roundClock(s.startedAt, s.hidingPeriodS, T0 + 60 * MIN, s.pauses).ms).toBe(28 * MIN)
  })

  it('counts overlap only', () => {
    expect(pausedMs([{ from: 10, to: 20 }], 15, 100)).toBe(5)
    expect(pausedMs([{ from: 10, to: 20 }], 0, 12)).toBe(2)
  })

  it('clears the map from the move and shades the circle around the old bar', () => {
    const asked = ev('question_asked', { question_id: 'q1', round: 1, type: 'radar', option_id: '1km', params: { center: [153, -27.4], distance_m: 1000 }, deadline_at: iso(T0 + 40 * MIN) }, T0 + 35 * MIN)
    const answered = ev('question_answered', { question_id: 'q1', answer: 'no' }, T0 + 36 * MIN)
    const before = derivePlay([started, seeking, asked, answered])
    const after = derivePlay([started, seeking, asked, answered, moveStarted()])
    expect(shadable(before)).toHaveLength(1)
    expect(shadable(after)).toEqual([])
    expect(after.move?.from.name).toBe('The Pub')
    expect(moveConstraint(after.move, 100)).toHaveProperty('keep')
    // Host cancels it: the hiders stayed, so the earlier answer counts again.
    const cancelled = derivePlay([started, seeking, asked, answered, moveStarted(), ev('move_cancelled', { round: 1 }, T0 + 41 * MIN)])
    expect(cancelled.movedSeq).toBe(before.movedSeq)
  })

  it('runs until hider_moved, and asks the server to settle when due', () => {
    const play = derivePlay([started, seeking, moveStarted()])
    expect(moveRunning(play.move, T0 + 45 * MIN)).toBe(true)
    expect(moveRunning(play.move, T0 + 50 * MIN)).toBe(false)
    expect(dueTimer(play, T0 + 45 * MIN)).toBeNull()
    expect(dueTimer(play, T0 + 50 * MIN)).toMatch(/^move:/)
    const over = derivePlay([started, seeking, moveStarted(), ev('hider_moved', { round: 1, at: iso(T0 + 50 * MIN), period_over: true })])
    expect(over.move?.endedAt).toBe(T0 + 50 * MIN)
    expect(dueTimer(over, T0 + 51 * MIN)).toBeNull()
  })

  it('keeps the hiders picking until the period ends', () => {
    const pick = (open: boolean) =>
      ev('bar_chosen', { round: 1, venue_id: 'v2', name: 'Two', lng: 153, lat: -27.4, radius_m: 100, moved: true, move_open: open }, T0, 'hiders')
    const card = ev('card_played', { round: 1, card: { params: { action: 'move', duration_s: 600 } } })
    expect(deriveHiding([card, pick(true)], 1).moving).toBe(true)
    expect(deriveHiding([card, pick(true), ev('hider_moved', { round: 1, period_over: true })], 1).moving).toBe(false)
    expect(deriveHiding([card, pick(false)], 1).moving).toBe(false)
  })

  it('cannot be cast before seeking or in the endgame', () => {
    const move = { behaviour: 'powerup', params: { action: 'move', duration_s: 600 } } as unknown as CardDef
    const ok = { pendingQuestion: false, barChosen: true, moving: false, handSize: 3, seeking: true, frozen: false }
    expect(castBlocker(move, ok)).toBeNull()
    expect(castBlocker(move, { ...ok, seeking: false })).toMatch(/seeking/)
    expect(castBlocker(move, { ...ok, frozen: true })).toMatch(/endgame/)
  })
})
