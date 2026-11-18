import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { deriveOverrides, effectiveEvents, openRequests, undoneOverrides, undoVotesFor } from './state'
import { availableOverrides, needsHiderApproval, OVERRIDES } from './catalogue'
import { derivePlay, shownEnd } from '../play/state'
import { deriveCards, lockedUntil, openProofs } from '../cards/state'
import { deriveLobby } from '../lobby/state'
import { deriveHiding, hidingPeriodAt } from '../hiding/state'

let seq = 0
const T0 = Date.parse('2026-12-01T10:00:00Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()
function ev(type: string, payload: Record<string, unknown> = {}, visibility: GameEvent['visibility'] = 'all'): GameEvent {
  seq += 1
  return { game_id: 'g', seq, type, visibility, actor_id: null, payload, created_at: at(seq) }
}
const started = () =>
  ev('game_started', {
    round: 1,
    started_at: at(0),
    hiding_period_s: 1800,
    players: [],
    deck: [{ card_id: 'veto', name: 'Veto', category: 'powerup', behaviour: 'powerup', params: { action: 'veto' }, copies: 1 }],
    hand_limit: 6,
  })
const asked = (id: string) =>
  ev('question_asked', { question_id: id, round: 1, type: 'radar', option_id: '1km', prompt: 'Within ___?', params: { distance_m: 1000 }, asked_at: at(seq), deadline_at: at(seq + 300), deadline_s: 300, reward: { draw: 2, pick: 1 } })

describe('undo', () => {
  it('drops the events of an undone override, keeping its audit event', () => {
    seq = 0
    const events = [
      started(),
      asked('q1'),
      ev('answer_overdue', { question_id: 'q1' }),
      ev('penalty_cancelled', { question_id: 'q1', override_id: 'o1' }),
      ev('override', { override_id: 'o1', kind: 'cancel_penalty', summary: 'Cancelled', reason: 'bug' }),
      ev('override_undone', { target_id: 'o1', override_id: 'o2' }),
      ev('override', { override_id: 'o2', kind: 'undo', summary: 'Undid: Cancelled', reason: 'oops', target_id: 'o1' }),
    ]
    const eff = effectiveEvents(events)
    expect(eff.map((e) => e.type)).not.toContain('penalty_cancelled')
    expect(eff.filter((e) => e.type === 'override')).toHaveLength(2)
    expect(derivePlay(eff).penalties).toBe(1)
    expect(derivePlay(events).penalties).toBe(0)
    const o = deriveOverrides(eff).overrides
    expect(o.find((x) => x.id === 'o1')?.undone).toBe(true)
    expect(derivePlay(eff).log.find((l) => l.overrideId === 'o1')?.undone).toBe(true)
  })

  it('undoing an undo brings the original back', () => {
    seq = 0
    const events = [
      ev('penalty_added', { team: 'hiders', cost: 'shot', label: 'x', override_id: 'o1' }),
      ev('override_undone', { target_id: 'o1', override_id: 'o2' }),
      ev('override_undone', { target_id: 'o2', override_id: 'o3' }),
    ]
    expect([...undoneOverrides(events)].sort()).toEqual(['o2'])
    expect(effectiveEvents(events).map((e) => e.type)).toEqual(['penalty_added', 'override_undone'])
  })

  it('leaves the log as it is when nothing is undone', () => {
    const events = [ev('override', { override_id: 'o1' })]
    expect(effectiveEvents(events)).toBe(events)
  })
})

describe('requests', () => {
  it('tracks a seeker host request until a hider approves or declines', () => {
    seq = 0
    const events = [
      ev('override_requested', { request_id: 'r1', kind: 'set_bar', reason: 'wrong bar', by: 'h', params: {} }),
      ev('override_requested', { request_id: 'r2', kind: 'reshuffle', reason: 'empty', by: 'h', params: {} }),
    ]
    expect(openRequests(deriveOverrides(events)).map((r) => r.id)).toEqual(['r1', 'r2'])
    events.push(ev('override', { override_id: 'o1', kind: 'set_bar', private: true, request_id: 'r1', summary: "Changed the hider's bar" }))
    events.push(ev('override_declined', { request_id: 'r2' }))
    events.push(ev('override_detail', { override_id: 'o1', summary: 'Bar set to Felons' }, 'hiders'))
    const s = deriveOverrides(events)
    expect(openRequests(s)).toEqual([])
    expect(s.overrides[0].detail).toBe('Bar set to Felons')
    expect(derivePlay(events).log.find((l) => l.overrideId === 'o1')?.text).toBe('Bar set to Felons')
  })
})

describe('reducers', () => {
  it('questions: void, reopen, paused deadline', () => {
    seq = 0
    const events = [started(), asked('q1'), ev('question_voided', { question_id: 'q1' })]
    expect(derivePlay(events).pending).toBeNull()
    expect(derivePlay(events).questions[0].closedBy).toBe('void')
    events.push(ev('question_reopened', { question_id: 'q1', deadline_at: at(900), deadline_s: 120 }))
    let p = derivePlay(events)
    expect(p.pending?.id).toBe('q1')
    expect(p.pending?.deadlineAt).toBe(Date.parse(at(900)))
    events.push(ev('timer_changed', { timer: 'answer', id: 'q1', op: 'pause', ends_at: null, paused_left_s: 90 }))
    p = derivePlay(events)
    expect(p.pending?.deadlineAt).toBe(Infinity)
    expect(shownEnd(p.pending!.deadlineAt, p.pending!.pausedLeftMs, 5000)).toBe(5000 + 90_000)
    events.push(ev('question_answered', { question_id: 'q1', answer: 'yes', answered_at: at(seq), by_override: true }))
    expect(derivePlay(events).pending).toBeNull()
  })

  it('hiding period: pause, more time back into hiding', () => {
    seq = 0
    const events = [started(), ev('seeking_started', { at: at(1800) })]
    events.push(ev('timer_changed', { timer: 'hiding', op: 'add', ends_at: at(2400), paused_left_s: null, status: 'hiding', hiding_period_s: 2400 }))
    const lobby = deriveLobby(events)
    expect(lobby.status).toBe('hiding')
    expect(lobby.started?.hidingPeriodS).toBe(2400)
    expect(derivePlay(events).seekingStarted).toBe(false)
    events.push(ev('timer_changed', { timer: 'hiding', op: 'pause', ends_at: null, paused_left_s: 60, status: 'hiding', hiding_period_s: 2147483647 }))
    const s = deriveLobby(events).started!
    expect(s.hidingPausedLeftMs).toBe(60_000)
    expect(hidingPeriodAt(s, T0 + 100_000)).toBe(160)
  })

  it('cards: drinks resolved, cards given and removed, veto cancelled, paused lock', () => {
    seq = 0
    const events = [
      started(),
      ev('drink_due', { proof_id: 'p1', team: 'seekers', cost: 'drink', label: 'Veto: X' }),
      ev('curse_vetoed', { instance_id: 'i1', name: 'X', lock_s: 600, lock_starts_at: at(2), lock_ends_at: at(602) }),
    ]
    expect(openProofs(deriveCards(events), 'seekers')).toHaveLength(1)
    events.push(ev('timer_changed', { timer: 'veto_lock', id: 'i1', op: 'pause', ends_at: null, paused_left_s: 300 }))
    expect(lockedUntil(deriveCards(events), T0)).toBe(T0 + 300_000)
    events.push(ev('veto_cancelled', { instance_id: 'i1', bans: [{ type: 'radar', option_id: '1km' }] }))
    events.push(ev('drink_resolved', { proof_id: 'p1', resolution: 'cancelled' }))
    let c = deriveCards(events)
    expect(c.vetoes).toEqual([])
    expect(c.bans.map((b) => b.optionId)).toEqual(['1km'])
    expect(openProofs(c, 'seekers')).toEqual([])
    events.push(ev('card_given', { instance_id: 'c1', card: { card_id: 'new', name: 'New', behaviour: 'text', copies: 0 } }, 'hiders'))
    c = deriveCards(events)
    expect(c.hand).toEqual([{ instanceId: 'c1', cardId: 'new' }])
    expect(c.deck.new.name).toBe('New')
    events.push(ev('card_removed', { instance_id: 'c1' }, 'hiders'), ev('hand_limit_changed', { hand_limit: 9 }), ev('ban_lifted', { type: 'radar', option_id: '1km' }))
    c = deriveCards(events)
    expect(c.hand).toEqual([])
    expect(c.handLimit).toBe(9)
    expect(c.bans).toEqual([])
  })

  it('host change and cancelled move', () => {
    seq = 0
    const events = [
      ev('game_created', { code: 'ABCD', host_id: 'h', host_name: 'H' }),
      ev('player_joined', { user_id: 'a', name: 'A' }),
      ev('host_changed', { user_id: 'a' }),
    ]
    const l = deriveLobby(events)
    expect(l.hostId).toBe('a')
    expect(l.players.find((p) => p.userId === 'a')?.isHost).toBe(true)
    expect(l.players.find((p) => p.userId === 'h')?.isHost).toBe(false)
    seq = 0
    const round = [
      started(),
      ev('card_played', { round: 1, instance_id: 'm', card: { card_id: 'move', behaviour: 'powerup', params: { action: 'move' } } }),
      ev('move_cancelled', { round: 1 }),
    ]
    expect(deriveCards(round).moving).toBe(false)
    expect(deriveHiding(round, 1).moving).toBe(false)
  })
})

describe('catalogue', () => {
  it('offers every override kind the server accepts, and only those', () => {
    const sql = readFileSync('supabase/migrations/20261213090000_host_overrides.sql', 'utf8')
    const list = sql.match(/if v_kind is null or v_kind not in \(([\s\S]*?)\) then/)![1]
    const kinds = [...list.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()
    expect(OVERRIDES.map((o) => o.kind).sort()).toEqual(kinds)
  })

  it('a non-host hider sees hider-only fixes and undo; other seekers only undo; no team, nothing', () => {
    expect(availableOverrides(false, true, true).every((o) => o.private || o.kind === 'undo')).toBe(true)
    expect(availableOverrides(false, false, true).map((o) => o.kind)).toEqual(['undo'])
    expect(availableOverrides(false, false, false)).toEqual([])
    expect(availableOverrides(true, false, true)).toHaveLength(OVERRIDES.length)
  })

  it('an undo request waits for a yes from each team', () => {
    seq = 0
    const events = [ev('override_requested', { request_id: 'u1', kind: 'undo', team: 'seekers', reason: 'r', summary: 'Undo: x', params: { override_id: 'o1' } })]
    expect(undoVotesFor(deriveOverrides(events), 'seekers')).toEqual([])
    expect(undoVotesFor(deriveOverrides(events), 'hiders').map((r) => r.id)).toEqual(['u1'])
    events.push(ev('override_confirmed', { request_id: 'u1', team: 'hiders' }))
    const r = deriveOverrides(events).requests[0]
    expect(r.confirmed).toEqual({ hiders: true, seekers: true })
    expect(undoVotesFor(deriveOverrides(events), 'hiders')).toEqual([])
  })

  it('a seeker host needs a hider for hider-only fixes and for moving someone onto the hiders', () => {
    const bar = OVERRIDES.find((o) => o.kind === 'set_bar')!
    const move = OVERRIDES.find((o) => o.kind === 'move_player')!
    expect(needsHiderApproval(bar, false)).toBe(true)
    expect(needsHiderApproval(bar, true)).toBe(false)
    expect(needsHiderApproval(move, false, { team: 'hiders' })).toBe(true)
    expect(needsHiderApproval(move, false, { team: 'seekers' })).toBe(false)
    expect(needsHiderApproval(OVERRIDES.find((o) => o.kind === 'undo')!, false)).toBe(false)
  })

  it('every option explains itself in one line', () => {
    for (const o of OVERRIDES) expect(o.line.length).toBeLessThan(110)
  })
})
