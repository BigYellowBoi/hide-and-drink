import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { clockLabel, deriveHiding, formatClock, hidingZone, positionAge, roundClock } from './state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility: 'hiders',
  actor_id: null,
  payload,
  created_at: '',
})

const bar = (round: number, name = 'The Pub') =>
  ev('bar_chosen', { round, venue_id: `v-${name}`, name, lng: 153, lat: -27.4, radius_m: 100, late: false })

describe('deriveHiding', () => {
  it('starts with no bar and no freeze', () => {
    expect(deriveHiding([], 1)).toEqual({ bar: null, frozen: false, moving: false })
  })

  it('reads the chosen bar and follows freeze changes', () => {
    const events = [bar(1), ev('freeze_changed', { round: 1, frozen: true })]
    const s = deriveHiding(events, 1)
    expect(s.bar).toMatchObject({ venueId: 'v-The Pub', name: 'The Pub', lng: 153, lat: -27.4, radiusM: 100, late: false })
    expect(s.frozen).toBe(true)
    expect(deriveHiding([...events, ev('freeze_changed', { round: 1, frozen: false })], 1).frozen).toBe(false)
  })

  it('ignores other rounds', () => {
    const events = [bar(1, 'Old'), ev('freeze_changed', { round: 1, frozen: true }), bar(2, 'New')]
    expect(deriveHiding(events, 2)).toMatchObject({ bar: { name: 'New' }, frozen: false })
    expect(deriveHiding(events, 3).bar).toBeNull()
  })

  it('skips malformed bar events', () => {
    expect(deriveHiding([ev('bar_chosen', { round: 1, name: 'x' })], 1).bar).toBeNull()
  })
})

describe('hidingZone', () => {
  it('uses config values', () => {
    expect(
      hidingZone({
        seeker_location_interval_s: 30,
        hiding_zone: { bar_radius_m: 150, freeze_when_seeker_within_m: 120 },
      }),
    ).toEqual({ barRadiusM: 150, freezeRadiusM: 120, locationIntervalS: 30 })
  })

  it('falls back to defaults (freeze radius follows the bar radius)', () => {
    expect(hidingZone({})).toEqual({ barRadiusM: 100, freezeRadiusM: 100, locationIntervalS: 20 })
    expect(hidingZone({ hiding_zone: { bar_radius_m: 80, freeze_when_seeker_within_m: null } }).freezeRadiusM).toBe(80)
  })
})

describe('roundClock', () => {
  it('counts down the hiding period, then up through seeking', () => {
    expect(roundClock(0, 60, 15_000)).toEqual({ phase: 'hiding', ms: 45_000 })
    expect(roundClock(0, 60, 60_000)).toEqual({ phase: 'seeking', ms: 0 })
    expect(roundClock(0, 60, 90_000)).toEqual({ phase: 'seeking', ms: 30_000 })
  })
})

describe('formatClock', () => {
  it('formats minutes and hours', () => {
    expect(formatClock(59_001)).toBe('1:00')
    expect(formatClock(0)).toBe('0:00')
    expect(formatClock(3_600_000)).toBe('1:00:00')
    expect(formatClock(61_999, { up: true })).toBe('1:01')
    expect(formatClock(-5)).toBe('0:00')
  })
})

describe('positionAge', () => {
  it('is null while fresh and labels stale positions', () => {
    expect(positionAge(0, 50_000, 20)).toBeNull()
    expect(positionAge(0, 55_000, 20)).toBe('55 s')
    expect(positionAge(0, 200_000, 20)).toBe('3 min')
  })
})

describe('deriveHiding: Move', () => {
  const ev = (type: string, payload: Record<string, unknown>, seq: number) => ({
    game_id: 'g',
    seq,
    type,
    visibility: 'hiders' as const,
    actor_id: null,
    payload: { round: 1, ...payload },
    created_at: '2026-11-20T10:00:00Z',
  })
  it('a Move reopens the picker until the new bar is locked in', () => {
    const chosen = ev('bar_chosen', { venue_id: 'a', name: 'A', lng: 153, lat: -27 }, 1)
    const move = ev('card_played', { card: { card_id: 'move', params: { action: 'move' } } }, 2)
    const s = deriveHiding([chosen, move], 1)
    expect(s.moving).toBe(true)
    expect(s.bar?.venueId).toBe('a')
    const moved = deriveHiding([chosen, move, ev('bar_chosen', { venue_id: 'b', name: 'B', lng: 153.01, lat: -27, moved: true }, 3)], 1)
    expect(moved).toMatchObject({ moving: false, bar: { venueId: 'b' } })
  })
})

describe('clockLabel', () => {
  it('reads like the main clock: time left while hiding, time since seeking started after', () => {
    const start = 1_000_000
    expect(clockLabel(start + 60_000, start, 53)).toBe('+0:07')
    expect(clockLabel(start + 53_000 + 41 * 60_000, start, 53)).toBe('+41:00')
    expect(clockLabel(start + 10_000, start, 1800)).toBe('−29:50')
  })
})
