import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { cardFacts, deriveCards, effectPhase, effectTimer, FOLLOWUP_WINDOW_MS, liveEffects, questionsBlockedBy } from './state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, visibility: GameEvent['visibility'] = 'all'): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: null,
  payload,
  created_at: '2026-11-20T10:00:00Z',
})

const card = (id: string, behaviour: string, params: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  card_id: id,
  name: id.toUpperCase(),
  category: behaviour === 'time_bonus' ? 'time_bonus' : 'curse',
  category_name: 'Curse',
  colour: '#EC353A',
  behaviour,
  text: `${id} text`,
  params,
  cast_cost: 'drink',
  can_veto: true,
  copies: 1,
  ...extra,
})

const deck = [
  card('cuisine', 'until_cleared', { blocks_questions: true }),
  card('escape', 'timed', { duration_s: 180, followup_s: 600 }, { can_veto: false }),
  card('bonus', 'time_bonus', { minutes: 4 }, { copies: 3, cast_cost: null }),
]
const started = ev('game_started', { round: 1, deck, hand_limit: 4 })
const drawn = ev(
  'cards_drawn',
  {
    round: 1,
    draw_id: 'd1',
    question_id: 'q1',
    pick: 1,
    cards: [
      { instance_id: 'i1', card_id: 'cuisine' },
      { instance_id: 'i2', card_id: 'bonus' },
    ],
    pile_left: 3,
  },
  'hiders',
)
const kept = ev('cards_kept', { round: 1, draw_id: 'd1', kept: ['i1'], discarded: ['i2'] }, 'hiders')

describe('deriveCards', () => {
  it('reads the deck from game_started', () => {
    const s = deriveCards([started])
    expect(s.deckSize).toBe(5)
    expect(s.handLimit).toBe(4)
    expect(s.deck.escape.castCost).toBe('drink')
    expect(s.hand).toEqual([])
  })

  it('a draw is pending until kept, then the kept card is in the hand', () => {
    const d = deriveCards([started, drawn])
    expect(d.draws).toHaveLength(1)
    expect(d.pileLeft).toBe(3)
    const k = deriveCards([started, drawn, kept])
    expect(k.draws).toEqual([])
    expect(k.hand).toEqual([{ instanceId: 'i1', cardId: 'cuisine' }])
    expect(k.log.map((l) => l.text)).toEqual(['Drew 2, keep 1', 'Kept CUISINE'])
    expect(k.log.every((l) => l.private)).toBe(true)
  })

  it('discarding hand cards in a keep removes them', () => {
    const second = ev(
      'cards_drawn',
      { round: 1, draw_id: 'd2', pick: 1, cards: [{ instance_id: 'i3', card_id: 'escape' }], pile_left: 2 },
      'hiders',
    )
    const keep2 = ev('cards_kept', { draw_id: 'd2', kept: ['i3'], discarded: ['i1'] }, 'hiders')
    expect(deriveCards([started, drawn, kept, second, keep2]).hand.map((c) => c.instanceId)).toEqual(['i3'])
  })

  it('a blocking until_cleared curse blocks questions until cleared', () => {
    const played = ev('card_played', {
      round: 1,
      instance_id: 'i1',
      card: deck[0],
      played_at: '2026-11-20T10:00:00Z',
      effect_id: 'e1',
      blocks_questions: true,
    })
    const s = deriveCards([started, drawn, kept, played])
    expect(s.hand).toEqual([])
    expect(questionsBlockedBy(s).map((e) => e.id)).toEqual(['e1'])
    const now = Date.parse('2026-11-20T10:05:00Z')
    expect(effectPhase(s.effects[0], now)).toBe('until_cleared')

    const asked = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e1' })])
    expect(effectPhase(asked.effects[0], now)).toBe('awaiting_confirm')
    expect(questionsBlockedBy(asked)).toHaveLength(1)

    const rejected = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e1' }), ev('effect_clear_rejected', { effect_id: 'e1' })])
    expect(rejected.effects[0].status).toBe('active')

    const cleared = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e1' }), ev('effect_cleared', { effect_id: 'e1' })])
    expect(questionsBlockedBy(cleared)).toEqual([])
    expect(liveEffects(cleared, now)).toEqual([])
  })

  it('timed cards count down on server time, with an optional follow-on', () => {
    const t0 = Date.parse('2026-11-20T10:00:00Z')
    const played = ev('card_played', {
      instance_id: 'i9',
      card: deck[1],
      played_at: '2026-11-20T10:00:00Z',
      effect_id: 'e2',
      duration_s: 180,
      ends_at: '2026-11-20T10:03:00Z',
      followup_s: 600,
    })
    const s = deriveCards([started, played])
    const e = s.effects[0]
    expect(effectPhase(e, t0 + 60_000)).toBe('running')
    expect(effectTimer(e, t0 + 60_000)).toEqual([t0 + 180_000, 180])
    expect(effectPhase(e, t0 + 200_000)).toBe('followup_available')
    expect(effectPhase(e, t0 + 180_000 + FOLLOWUP_WINDOW_MS)).toBe('over')

    const f = deriveCards([started, played, ev('effect_followup_started', { effect_id: 'e2', ends_at: '2026-11-20T10:14:00Z' })])
    expect(effectPhase(f.effects[0], t0 + 300_000)).toBe('followup')
    expect(effectTimer(f.effects[0], t0 + 300_000)).toEqual([t0 + 840_000, 600])
    expect(effectPhase(f.effects[0], t0 + 900_000)).toBe('over')
  })

  it('time bonuses add up', () => {
    const play = (i: string) =>
      ev('card_played', { instance_id: i, card: deck[2], played_at: '2026-11-20T10:00:00Z', time_bonus_s: 240 })
    const s = deriveCards([started, play('a'), play('b')])
    expect(s.timeBonusS).toBe(480)
    expect(s.effects).toEqual([])
    expect(s.log.at(-1)?.text).toBe('BONUS played: +4 min for the hider')
  })

  it('a new round starts with an empty hand', () => {
    const s = deriveCards([started, drawn, kept, ev('game_started', { round: 2, deck })])
    expect(s.round).toBe(2)
    expect(s.hand).toEqual([])
  })
})

describe('cardFacts', () => {
  it('summarises params', () => {
    const s = deriveCards([started])
    expect(cardFacts(s.deck.escape)).toEqual(['3 min, then 10 min if missed', "Can't veto"])
    expect(cardFacts(s.deck.cuisine)).toEqual(['Blocks questions'])
    expect(cardFacts(s.deck.bonus)).toEqual(['+4 min'])
  })
})
