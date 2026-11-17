import { describe, expect, it } from 'vitest'
import { EventSequencer } from './sequencer'
import type { Audience, GameEvent } from './types'

const ev = (seq: number, prev?: Partial<Record<Audience, number>>): GameEvent => ({
  game_id: 'g',
  seq,
  type: 't',
  visibility: 'all',
  actor_id: null,
  payload: {},
  created_at: '',
  ...(prev ? { prev_seq: prev } : {}),
})

function setup(audience: Audience = 'none') {
  const applied: number[] = []
  const s = new EventSequencer(audience, (e) => applied.push(e.seq))
  return { s, applied }
}

describe('EventSequencer without prev_seq (fetched rows, old broadcasts)', () => {
  it('applies contiguous events in order', () => {
    const { s, applied } = setup()
    expect(s.receive(ev(1))).toBe('applied')
    expect(s.receive(ev(2))).toBe('applied')
    expect(applied).toEqual([1, 2])
    expect(s.lastSeq).toBe(2)
    expect(s.hasGap).toBe(false)
  })

  it('ignores duplicates, including ones already buffered', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    expect(s.receive(ev(1))).toBe('duplicate')
    s.receive(ev(3))
    expect(s.receive(ev(3))).toBe('duplicate')
    expect(applied).toEqual([1])
  })

  it('buffers out-of-order events and releases them when the gap fills', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    expect(s.receive(ev(4))).toBe('buffered')
    expect(s.receive(ev(3))).toBe('buffered')
    expect(s.hasGap).toBe(true)
    expect(applied).toEqual([1])
    expect(s.receive(ev(2))).toBe('applied')
    expect(applied).toEqual([1, 2, 3, 4])
    expect(s.hasGap).toBe(false)
  })
})

describe('EventSequencer with prev_seq', () => {
  it('skips seqs the audience cannot see without reporting a gap', () => {
    const { s, applied } = setup('seekers')
    s.receive(ev(1, { none: 0, hiders: 0, seekers: 0 }))
    // seq 2 was hider-only; 3 says the seekers' previous event was 1
    expect(s.receive(ev(3, { none: 1, hiders: 2, seekers: 1 }))).toBe('applied')
    expect(applied).toEqual([1, 3])
    expect(s.hasGap).toBe(false)
  })

  it('detects a missed visible event', () => {
    const { s, applied } = setup('seekers')
    s.receive(ev(1, { seekers: 0 }))
    expect(s.receive(ev(5, { seekers: 4 }))).toBe('buffered')
    expect(applied).toEqual([1])
    expect(s.hasGap).toBe(true)
  })

  it('reads prev_seq for its own audience only', () => {
    const hider = setup('hiders')
    const seeker = setup('seekers')
    const e = ev(3, { none: 1, hiders: 2, seekers: 1 })
    for (const { s } of [hider, seeker]) s.receive(ev(1, { none: 0, hiders: 0, seekers: 0 }))
    expect(hider.s.receive(e)).toBe('buffered') // hider is missing seq 2
    expect(seeker.s.receive(e)).toBe('applied')
  })

  it('drains a chain of buffered events that arrived across two topics', () => {
    const { s, applied } = setup('hiders')
    s.receive(ev(1, { hiders: 0 }))
    s.receive(ev(4, { hiders: 3 }))
    s.receive(ev(3, { hiders: 2 }))
    expect(applied).toEqual([1])
    s.receive(ev(2, { hiders: 1 }))
    expect(applied).toEqual([1, 2, 3, 4])
  })
})

describe('EventSequencer.applyFetched', () => {
  it('fills a gap from a fetch and then releases buffered events', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    s.receive(ev(5))
    const gap = s.applyFetched(1, [ev(2), ev(3), ev(4)])
    expect(gap).toBe(false)
    expect(applied).toEqual([1, 2, 3, 4, 5])
  })

  it('treats a fetch as complete, so hidden seqs inside it are not gaps', () => {
    const { s, applied } = setup('seekers')
    s.receive(ev(1))
    // Fetch (RLS-filtered) returns 3 and 6: 2, 4, 5 are hider-only.
    s.applyFetched(1, [ev(3), ev(6)])
    expect(applied).toEqual([1, 3, 6])
    expect(s.lastSeq).toBe(6)
    expect(s.hasGap).toBe(false)
  })

  it('merges buffered live events inside the fetched range without duplicates', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    s.receive(ev(3))
    s.applyFetched(1, [ev(2), ev(3)])
    expect(applied).toEqual([1, 2, 3])
  })

  it('applies a buffered event inside the fetched range even if the fetch missed it', () => {
    // A broadcast arrived during the fetch; its seq sits below the fetch's highest seq.
    const { s, applied } = setup()
    s.receive(ev(1))
    s.receive(ev(3))
    s.applyFetched(1, [ev(2), ev(4)])
    expect(applied).toEqual([1, 2, 3, 4])
  })

  it('reports a remaining gap beyond the fetched range', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    s.receive(ev(9))
    expect(s.applyFetched(1, [ev(2)])).toBe(true)
    expect(applied).toEqual([1, 2])
    expect(s.hasGap).toBe(true)
  })

  it('skips fetched events already applied live while the fetch was in flight', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    s.receive(ev(2)) // live, during a fetch that started after seq 0
    s.applyFetched(0, [ev(1), ev(2), ev(3)])
    expect(applied).toEqual([1, 2, 3])
  })

  it('an empty fetch changes nothing', () => {
    const { s, applied } = setup()
    s.receive(ev(1))
    expect(s.applyFetched(1, [])).toBe(false)
    expect(applied).toEqual([1])
    expect(s.lastSeq).toBe(1)
  })

  it('reset starts over for a new audience', () => {
    const { s } = setup('none')
    s.receive(ev(1))
    s.receive(ev(4))
    s.reset('hiders')
    expect(s.lastSeq).toBe(0)
    expect(s.hasGap).toBe(false)
    expect(s.receive(ev(1, { hiders: 0 }))).toBe('applied')
  })
})
