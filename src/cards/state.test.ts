import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import {
  banKey,
  hiderProofKind,
  hiderProofPrompt,
  judgeOf,
  proofPrompt,
  keepDiscardLabel,
  proofToastText,
  setupFor,
  bannedSet,
  cardDetails,
  cardFacts,
  evidenceFor,
  parseCard,
  cardUtility,
  castBlocker,
  castChoice,
  castCost,
  clearable,
  costPayer,
  deriveCards,
  lockedUntil,
  nextVetoLockS,
  openProofs,
  vetoable,
  vetoLock,
  effectPhase,
  effectTimer,
  FOLLOWUP_WINDOW_MS,
  handBonusS,
  isPlayable,
  liveEffects,
  questionsBlockedBy,
  triviaTodo,
  triviaWaiting,
  drinkTeams,
  otherBlocks,
} from './state'

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

  it('a timed task (follow-on) can be marked done until the lock starts; a plain timed one cannot', () => {
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
    expect(clearable(s.effects[0], t0 + 60_000)).toBe(true)
    expect(clearable(s.effects[0], t0 + 200_000)).toBe(true)

    const asked = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e2' })])
    expect(effectPhase(asked.effects[0], t0 + 60_000)).toBe('awaiting_confirm')
    expect(clearable(asked.effects[0], t0 + 60_000)).toBe(false)
    const done = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e2' }), ev('effect_cleared', { effect_id: 'e2' })])
    expect(effectPhase(done.effects[0], t0 + 60_000)).toBe('over')
    expect(effectPhase(done.effects[0], t0 + 200_000)).toBe('over')

    const locked = deriveCards([started, played, ev('effect_followup_started', { effect_id: 'e2', ends_at: '2026-11-20T10:14:00Z' })])
    expect(clearable(locked.effects[0], t0 + 300_000)).toBe(false)

    const plain = deriveCards([started, ev('card_played', { ...played.payload, followup_s: null })])
    expect(clearable(plain.effects[0], t0 + 60_000)).toBe(false)
  })

  it('time bonuses count only while held in the hand', () => {
    const draw = ev(
      'cards_drawn',
      {
        draw_id: 'd3',
        pick: 2,
        cards: [
          { instance_id: 'b1', card_id: 'bonus' },
          { instance_id: 'b2', card_id: 'bonus' },
          { instance_id: 'c1', card_id: 'escape' },
        ],
      },
      'hiders',
    )
    const keep = ev('cards_kept', { draw_id: 'd3', kept: ['b1', 'b2'], discarded: ['c1'] }, 'hiders')
    const s = deriveCards([started, draw, keep])
    expect(handBonusS(s)).toBe(480)
    expect(isPlayable(s.deck.bonus)).toBe(false)
    // Discarded to make room: no longer counts.
    const later = ev('cards_drawn', { draw_id: 'd4', pick: 1, cards: [{ instance_id: 'c2', card_id: 'cuisine' }] }, 'hiders')
    const swap = ev('cards_kept', { draw_id: 'd4', kept: ['c2'], discarded: ['b1'] }, 'hiders')
    expect(handBonusS(deriveCards([started, draw, keep, later, swap]))).toBe(240)
    expect(handBonusS(deriveCards([started]))).toBe(0)
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

describe('cast costs', () => {
  it('the hider pays to cast any card, curses included, unless params.cost_team says', () => {
    const s = deriveCards([started])
    const curse = { ...s.deck.escape, castCost: 'drink' as const }
    expect(castCost(curse)).toBe('drink')
    expect(costPayer(curse)).toBe('hiders')
    const dbl = { ...s.deck.cuisine, category: 'drink', castCost: null, params: { cost: 'shot' } }
    expect(castCost(dbl)).toBe('shot')
    expect(costPayer(dbl)).toBe('hiders')
    expect(costPayer({ ...curse, params: { cost_team: 'seekers' } })).toBe('seekers')
    expect(castCost({ ...curse, castCost: 'free' })).toBeNull()
  })
})

describe('powerups, bans, vetoes, utilities and drink proofs', () => {
  const pu = (id: string, params: Record<string, unknown>, behaviour = 'powerup') =>
    card(id, behaviour, params, { category: 'powerup', cast_cost: null, can_veto: null })
  const deck2 = [
    ...deck,
    pu('veto', { action: 'veto' }),
    pu('dup', { action: 'duplicate' }),
    pu('dd', { action: 'discard_draw', discard: 1, draw: 2 }),
    pu('move', { action: 'move' }),
    pu('double', { reward_multiplier: 2, cost: 'shot' }, 'next_question_modifier'),
    card('brain', 'question_ban', { count: 3, distinct_types: true, until: 'end_of_run' }, { can_veto: false }),
    card('jam', 'timed', { duration_s: 1800, utility: 'dice', dice: 2 }),
  ]
  const s0 = ev('game_started', { round: 1, deck: deck2, hand_limit: 6 })
  const hand = ev(
    'cards_drawn',
    {
      draw_id: 'h',
      pick: 3,
      cards: [
        { instance_id: 'a', card_id: 'dup' },
        { instance_id: 'b', card_id: 'cuisine' },
        { instance_id: 'c', card_id: 'dd' },
      ],
    },
    'hiders',
  )
  const keepAll = ev('cards_kept', { draw_id: 'h', kept: ['a', 'b', 'c'], discarded: [] }, 'hiders')
  const played = (instance: string, id: string, extra: Record<string, unknown> = {}, vis: GameEvent['visibility'] = 'all') =>
    ev('card_played', { instance_id: instance, card: deck2.find((c) => c.card_id === id), played_at: '2026-11-20T10:00:00Z', ...extra }, vis)

  it('duplicate adds a copy to the hand; discard/draw removes the discarded cards', () => {
    const dup = played('a', 'dup', { duplicate: { of: 'b', instance_id: 'b2', card_id: 'cuisine' } }, 'hiders')
    const s = deriveCards([s0, hand, keepAll, dup])
    expect(s.hand.map((c) => c.instanceId)).toEqual(['b', 'c', 'b2'])
    expect(s.log.at(-1)).toMatchObject({ text: 'Duplicated CUISINE', private: true })
    const dd = played('c', 'dd', { discarded: ['b'] }, 'hiders')
    expect(deriveCards([s0, hand, keepAll, dup, dd]).hand.map((c) => c.instanceId)).toEqual(['b2'])
  })

  it('cast choices and blockers follow the card', () => {
    const s = deriveCards([s0])
    expect(castChoice(s.deck.dup)).toEqual({ kind: 'target' })
    expect(castChoice(s.deck.dd)).toEqual({ kind: 'discard', count: 1 })
    expect(castChoice(s.deck.brain)).toEqual({ kind: 'bans', count: 3, distinctTypes: true })
    const ctx = { pendingQuestion: false, barChosen: true, moving: false, handSize: 3 }
    expect(castBlocker(s.deck.veto, ctx)).toMatch(/question/)
    expect(castBlocker(s.deck.veto, { ...ctx, pendingQuestion: true })).toBeNull()
    expect(castBlocker(s.deck.move, { ...ctx, barChosen: false })).toMatch(/bar/)
    expect(castBlocker(s.deck.dd, { ...ctx, handSize: 1 })).toMatch(/discard/)
    expect(isPlayable(s.deck.veto)).toBe(true)
    expect(isPlayable({ ...s.deck.veto, params: { action: 'teleport' } })).toBe(false)
  })

  it('a modifier waits for the next answer', () => {
    const s = deriveCards([s0, played('x', 'double', { reward_multiplier: 2 })])
    expect(s.nextRewardMultiplier).toBe(2)
    expect(deriveCards([s0, played('x', 'double', { reward_multiplier: 2 }), ev('question_answered', {})]).nextRewardMultiplier).toBe(1)
  })

  it('bans are listed until vetoed', () => {
    const ban = played('z', 'brain', { bans: [{ type: 'radar', option_id: '1km', label: '1 km' }] })
    const s = deriveCards([s0, ban])
    expect([...bannedSet(s)]).toEqual([banKey('radar', '1km')])
    expect(s.log.at(-1)?.text).toBe('BRAIN played: banned 1 km')
  })

  it('move holds questions until hider_moved', () => {
    const s = deriveCards([s0, played('m', 'move')])
    expect(s.moving).toBe(true)
    expect(deriveCards([s0, played('m', 'move'), ev('hider_moved', {})]).moving).toBe(false)
  })

  it('a veto ends the curse and chains bar locks', () => {
    const t0 = Date.parse('2026-11-20T10:00:00Z')
    const curse = played('k', 'cuisine', { effect_id: 'e1', blocks_questions: true })
    const veto = ev('curse_vetoed', {
      instance_id: 'k',
      effect_id: 'e1',
      name: 'CUISINE',
      veto_number: 1,
      lock_s: 600,
      lock_starts_at: '2026-11-20T10:00:00Z',
      lock_ends_at: '2026-11-20T10:10:00Z',
      penalty: 'each seeker drinks',
    })
    const before = deriveCards([s0, curse])
    expect(vetoable(before, before.played[0], t0)).toBe(true)
    const s = deriveCards([s0, curse, veto])
    expect(s.effects[0].status).toBe('vetoed')
    expect(questionsBlockedBy(s)).toEqual([])
    expect(liveEffects(s, t0)).toEqual([])
    expect(vetoable(s, s.played[0], t0)).toBe(false)
    expect(vetoLock(s, t0 + 60_000)?.name).toBe('CUISINE')
    expect(lockedUntil(s, t0 + 60_000)).toBe(t0 + 600_000)
    expect(lockedUntil(s, t0 + 600_000)).toBeNull()
    expect(nextVetoLockS(s, { veto: { base_lock_s: 600, step_s: 300 } })).toBe(900)
    expect(nextVetoLockS(s, {})).toBe(1200)
    // Can't-veto curses and non-curses are never vetoable.
    const brain = deriveCards([s0, played('z', 'brain', { bans: [] })])
    expect(vetoable(brain, brain.played[0], t0)).toBe(false)
  })

  it('dice and wheel results are kept per card', () => {
    const jam = played('j', 'jam', { effect_id: 'e9', ends_at: '2026-11-20T10:30:00Z', duration_s: 1800 })
    const roll = ev('dice_rolled', { instance_id: 'j', name: 'JAM', dice: [3, 5], total: 8, by: 'u1' })
    const s = deriveCards([s0, jam, roll])
    expect(cardUtility(s.deck.jam)).toEqual({ kind: 'dice', dice: 2 })
    expect(s.rolls[0]).toMatchObject({ kind: 'dice', dice: [3, 5], total: 8 })
    expect(s.log.at(-1)?.text).toBe('JAM: rolled 3 + 5 = 8')
    const spin = ev('wheel_spun', { instance_id: 'j', name: 'JAM', result: 'Pirate' })
    expect(deriveCards([s0, spin]).rolls[0]).toMatchObject({ kind: 'wheel', result: 'Pirate' })
    expect(cardUtility({ ...s.deck.jam, params: { utility: 'wheel', wheel_url: 'https://x' } })).toEqual({
      kind: 'wheel',
      options: [],
      url: 'https://x',
    })
  })

  it('drink proofs stay open until a photo is sent', () => {
    const due = ev('drink_due', { proof_id: 'p1', team: 'seekers', cost: 'drink', label: 'Cheers' })
    const s = deriveCards([s0, due])
    expect(openProofs(s, 'seekers').map((p) => p.id)).toEqual(['p1'])
    expect(openProofs(s, 'hiders')).toEqual([])
    const done = deriveCards([s0, due, ev('drink_proved', { proof_id: 'p1', team: 'seekers', path: 'g/p1/x.jpg' })])
    expect(openProofs(done, 'seekers')).toEqual([])
    expect(done.log.at(-1)).toMatchObject({ kind: 'proof', photo: 'g/p1/x.jpg', photoBucket: 'drink-photos' })
  })

  it('curse evidence is sent from the curse, and a "not yet" reopens it', () => {
    const played = ev('card_played', { round: 1, instance_id: 'i1', card: deck[0], effect_id: 'e1', blocks_questions: true })
    const due = ev('proof_due', { proof_id: 'p2', team: 'seekers', label: 'CUISINE', effect_id: 'e1' })
    const s = deriveCards([s0, played, due])
    expect(openProofs(s, 'seekers')).toEqual([])
    expect(evidenceFor(s, 'e1')).toMatchObject({ id: 'p2', kind: 'evidence', path: null })
    const sent = [s0, played, due, ev('drink_proved', { proof_id: 'p2', team: 'seekers', path: 'g/p2/a.jpg' })]
    expect(evidenceFor(deriveCards(sent), 'e1')?.path).toBe('g/p2/a.jpg')
    expect(deriveCards(sent).log.at(-1)?.text).toBe('Seekers sent proof: CUISINE')
    const asked = [...sent, ev('effect_clear_requested', { effect_id: 'e1' }), ev('effect_clear_rejected', { effect_id: 'e1' })]
    expect(evidenceFor(deriveCards(asked), 'e1')?.path).toBeNull()
  })
})

describe('keeping a draw', () => {
  it('a card kept and discarded in the same keep never reaches the hand', () => {
    const s = deriveCards([started, drawn, ev('cards_kept', { round: 1, draw_id: 'd1', kept: [], discarded: ['i1', 'i2'] }, 'hiders')])
    expect(s.hand).toEqual([])
    expect(s.draws).toEqual([])
  })
})

describe('cardDetails', () => {
  it('lists cast cost, veto status, drinks, proof and rules', () => {
    const curse = parseCard(card('cuisine', 'until_cleared', { blocks_questions: true, proof: 'photo' }))!
    const rows = Object.fromEntries(cardDetails(curse).map((r) => [r.label, r.value]))
    expect(rows['Cast cost']).toBe('Drink, paid by the hiders')
    expect(rows.Veto).toMatch(/can veto/)
    expect(rows.Proof).toMatch(/before they can say they did it/)
    expect(rows.Rules).toBe('Blocks questions')
    const cheers = parseCard(card('cheers', 'text', { drinks: ['hiders', 'seekers'], proof: 'photo' }, { category: 'drink', cast_cost: null, can_veto: null }))!
    const c = Object.fromEntries(cardDetails(cheers).map((r) => [r.label, r.value]))
    expect(c['Cast cost']).toBe('Free')
    expect(c.Veto).toBeUndefined()
    expect(c.Drinks).toBe('Hiders and seekers drink when it\'s played')
    expect(c.Proof).toBe('Photo of each drink')
  })
})

describe('trivia curses', () => {
  const moll = card('moll', 'trivia', { blocks_questions: false, blocks: 'transport', count: 3, topic: 'Harry Potter' })
  const start = () => [
    ev('game_started', { round: 1, deck: [moll] }),
    ev('card_played', { round: 1, instance_id: 'i1', card: moll, effect_id: 'e1', blocks_questions: false, count: 3 }),
  ]

  it('waits for the hider to write the questions, without blocking questions', () => {
    const s = deriveCards(start())
    const e = s.effects[0]
    expect(e.trivia).toEqual({ count: 3, need: 3, topic: 'Harry Potter', questions: null, forced: false, lastFailed: null })
    expect(triviaTodo(e, 'hiders')).toBe('write')
    expect(triviaTodo(e, 'seekers')).toBeNull()
    expect(questionsBlockedBy(s)).toEqual([])
    expect(clearable(e, 0)).toBe(false)
    expect(liveEffects(s, 0)).toHaveLength(1)
    expect(cardFacts(parseCard(moll)!)).toContain('3 trivia questions (Harry Potter)')
    expect(isPlayable(parseCard(moll)!)).toBe(true)
  })

  it('answers come and get marked as a set; wrong ones go back, all right clears it', () => {
    const events = [
      ...start(),
      ev('trivia_set', { effect_id: 'e1', questions: ['Owl?', 'Gift?', 'Dog?'] }),
      ev('trivia_answered', { effect_id: 'e1', answers: ['Hedwig', 'Hat', 'Fluffy'], by: 's1' }),
    ]
    let s = deriveCards(events)
    expect(triviaTodo(s.effects[0], 'hiders')).toBe('mark')
    expect(triviaTodo(s.effects[0], 'seekers')).toBeNull()
    expect(triviaWaiting(s, 'hiders')).toHaveLength(1)

    events.push(
      ev('trivia_marked', {
        effect_id: 'e1',
        marks: [
          { correct: true, answer: 'Hedwig' },
          { correct: false, answer: 'Hat' },
          { correct: true, answer: 'Fluffy' },
        ],
      }),
    )
    s = deriveCards(events)
    const qs = s.effects[0].trivia!.questions!
    expect(qs[0]).toMatchObject({ correct: true, answer: 'Hedwig' })
    expect(qs[1]).toMatchObject({ correct: false, answer: null, wrong: ['Hat'] })
    expect(triviaTodo(s.effects[0], 'hiders')).toBeNull()
    expect(triviaTodo(s.effects[0], 'seekers')).toBe('answer')
    expect(s.log.map((l) => l.text)).toContain('MOLL: Q1, Q3 right; Q2 "Hat" wrong, try again')

    events.push(ev('trivia_answered', { effect_id: 'e1', answers: [null, 'Sock', null], by: 's1' }))
    s = deriveCards(events)
    expect(s.effects[0].trivia!.questions!.map((q) => q.answer)).toEqual(['Hedwig', 'Sock', 'Fluffy'])
    expect(triviaTodo(s.effects[0], 'hiders')).toBe('mark')

    events.push(ev('trivia_force_cleared', { effect_id: 'e1' }), ev('effect_cleared', { effect_id: 'e1' }))
    s = deriveCards(events)
    expect(s.effects[0].trivia!.questions!.every((q) => q.correct)).toBe(true)
    expect(effectPhase(s.effects[0], 0)).toBe('over')
    expect(triviaWaiting(s, 'seekers')).toEqual([])
  })
})

describe('playtest 2: Moll 1 of 3, seeker-confirmed curses, drink cards', () => {
  it('a set short of need_right is thrown out and the hider writes a new one', () => {
    const moll = card('moll', 'trivia', { count: 3, need_right: 1 })
    const events = [
      ev('game_started', { round: 1, deck: [moll] }),
      ev('card_played', { round: 1, instance_id: 'i1', card: moll, effect_id: 'e1', count: 3 }),
      ev('trivia_set', { effect_id: 'e1', questions: ['a', 'b', 'c'] }),
      ev('trivia_answered', { effect_id: 'e1', answers: ['x', 'y', 'z'], by: 's1' }),
      ev('trivia_marked', {
        effect_id: 'e1',
        reset: true,
        need: 1,
        marks: [
          { correct: false, answer: 'x' },
          { correct: false, answer: 'y' },
          { correct: false, answer: 'z' },
        ],
      }),
    ]
    const s = deriveCards(events)
    const e = s.effects[0]
    expect(e.trivia).toMatchObject({ need: 1, questions: null, lastFailed: { right: 0, total: 3 } })
    expect(e.status).toBe('active')
    expect(triviaTodo(e, 'hiders')).toBe('write')
    expect(s.log.at(-1)?.text).toBe('MOLL: Q1 "x", Q2 "y", Q3 "z" wrong; not enough right: the hider sends new questions')
  })

  it('a seeker_confirm curse waits for the seekers, then starts or drops', () => {
    const prison = card('prison', 'timed', { duration_s: 600, seeker_confirm: 'In the bar?' })
    const played = [
      ev('game_started', { round: 1, deck: [prison] }),
      ev('card_played', {
        round: 1,
        instance_id: 'i1',
        card: prison,
        effect_id: 'e1',
        duration_s: 600,
        ends_at: null,
        awaiting_seekers: true,
        seeker_confirm: 'In the bar?',
      }),
    ]
    let s = deriveCards(played)
    expect(s.effects[0]).toMatchObject({ status: 'awaiting_seekers', seekerConfirm: 'In the bar?' })
    expect(effectPhase(s.effects[0], 0)).toBe('awaiting_seekers')
    expect(effectTimer(s.effects[0], 0)).toBeNull()
    expect(liveEffects(s, 0)).toHaveLength(1)

    s = deriveCards([...played, ev('curse_checked', { effect_id: 'e1', applies: true, ends_at: '2026-11-20T10:10:00Z' })])
    expect(s.effects[0].status).toBe('active')
    expect(effectPhase(s.effects[0], Date.parse('2026-11-20T10:05:00Z'))).toBe('running')

    s = deriveCards([...played, ev('curse_checked', { effect_id: 'e1', applies: false, ends_at: null })])
    expect(s.effects[0].status).toBe('cleared')
    expect(liveEffects(s, 0)).toEqual([])
    expect(s.log.at(-1)?.text).toBe("Seekers say PRISON doesn't apply: dropped")
  })

  it('knows which teams a drink card makes drink', () => {
    const all = card('drinks_all_round', 'text', { drinks: ['hiders', 'seekers'] })
    const s = deriveCards([
      ev('game_started', { round: 1, deck: [all] }),
      ev('card_played', { round: 1, instance_id: 'i1', card: all }),
    ])
    expect(drinkTeams(s.played[0])).toEqual(['hiders', 'seekers'])
  })
})

describe('curses blocking transport', () => {
  it('groups curses in force by what they block, until cleared', () => {
    const clash = card('clash', 'until_cleared', { blocks_questions: false, blocks: 'transport' })
    const moll = card('moll', 'trivia', { blocks: 'transport', count: 3 })
    const events = [
      ev('game_started', { round: 1, deck: [clash, moll] }),
      ev('card_played', { round: 1, instance_id: 'i1', card: clash, effect_id: 'e1' }),
      ev('card_played', { round: 1, instance_id: 'i2', card: moll, effect_id: 'e2', count: 3 }),
    ]
    let s = deriveCards(events)
    expect(otherBlocks(s).map(([what, es]) => [what, es.map((e) => e.card.name)])).toEqual([['transport', ['CLASH', 'MOLL']]])
    expect(questionsBlockedBy(s)).toEqual([])
    s = deriveCards([...events, ev('effect_cleared', { effect_id: 'e1' }), ev('effect_cleared', { effect_id: 'e2' })])
    expect(otherBlocks(s)).toEqual([])
  })
})

describe('playtest 2 follow-ups', () => {
  it('names what goes when the hand is full', () => {
    expect(keepDiscardLabel([], ['Curse of Express Route'], [])).toBe('Discard Curse of Express Route, keep your hand')
    expect(keepDiscardLabel(['Veto'], [], ['Curse of Quan'])).toBe('Keep Veto, discard Curse of Quan')
    expect(keepDiscardLabel([], ['Veto'], ['Curse of Quan'])).toBe('Discard Veto, Curse of Quan')
  })

  it('a curse with hider_proof waits for the hiders, and a rejection keeps their photo', () => {
    const tourist = card('unguided_tourist', 'until_cleared', { blocks_questions: true, proof: 'photo', hider_proof: 'photo' })
    const events = [
      ev('game_started', { round: 1, deck: [tourist] }),
      ev('card_played', { round: 1, instance_id: 'i1', card: tourist, effect_id: 'e1' }),
      ev('proof_due', { round: 1, proof_id: 'p1', team: 'hiders', kind: 'setup', label: 'Tourist', effect_id: 'e1' }),
      ev('proof_due', { round: 1, proof_id: 'p2', team: 'seekers', label: 'Tourist', effect_id: 'e1' }),
    ]
    let s = deriveCards(events)
    expect(setupFor(s, 'e1')).toMatchObject({ id: 'p1', team: 'hiders', kind: 'setup', path: null })
    expect(evidenceFor(s, 'e1')?.id).toBe('p2')
    expect(openProofs(s, 'hiders')).toEqual([])
    const done = [
      ...events,
      ev('drink_proved', { proof_id: 'p1', team: 'hiders', path: 'g/p1/a.png', by: 'h1', kind: 'setup' }),
      ev('drink_proved', { proof_id: 'p2', team: 'seekers', path: 'g/p2/b.jpg', by: 's1' }),
      ev('effect_clear_requested', { effect_id: 'e1' }),
      ev('effect_clear_rejected', { effect_id: 'e1' }),
    ]
    s = deriveCards(done)
    expect(setupFor(s, 'e1')).toMatchObject({ path: 'g/p1/a.png', by: 'h1' })
    expect(setupFor(s, 'e1')?.doneAt).not.toBeNull()
    expect(evidenceFor(s, 'e1')).toMatchObject({ path: null, doneAt: null })
    expect(hiderProofKind(parseCard(tourist)!)).toBe('photo')
  })

  it('toast text for drinks, proofs and host fixes', () => {
    const base = {
      id: 'p',
      seq: 1,
      team: 'seekers' as const,
      kind: 'drink' as const,
      cost: 'drink' as const,
      label: 'Veto',
      path: 'x.jpg',
      effectId: null,
      instanceId: null,
      resolution: null,
      doneAt: 1,
      by: 's1',
    }
    const name = (id: string | null) => (id === 's1' ? 'Sam' : '?')
    expect(proofToastText(base, 'hiders', name).title).toBe('The seekers drank: Veto')
    expect(proofToastText(base, 'seekers', name).title).toBe('Your team drank: Veto')
    expect(proofToastText({ ...base, path: null, resolution: 'waived' }, 'hiders', name).body).toMatch(/host fix/)
  })
})

describe('judging a curse', () => {
  const scull = card('sculling', 'until_cleared', {
    blocks: 'transport',
    proof: 'video',
    hider_proof: 'video',
    hider_proof_prompt: 'Film your team chugging.',
    proof_prompt: 'Chug quicker.',
    judge_question: 'Who drank quicker?',
    judge_accept: 'Seekers',
    judge_reject: 'Hiders',
  })

  it('reads the prompts and the judge labels, with defaults', () => {
    const c = parseCard(scull)!
    expect(hiderProofPrompt(c)).toBe('Film your team chugging.')
    expect(proofPrompt(c)).toBe('Chug quicker.')
    expect(judgeOf(c)).toEqual({ question: 'Who drank quicker?', accept: 'Seekers', reject: 'Hiders' })
    const plain = parseCard(card('quan', 'until_cleared', { proof: 'photo', proof_prompt: '  ' }))!
    expect(proofPrompt(plain)).toBeNull()
    expect(judgeOf(plain)).toEqual({ question: null, accept: 'Confirm', reject: 'Not yet' })
  })

  it('logs the hider picking the hiders as a retry', () => {
    const played = ev('card_played', {
      round: 1,
      instance_id: 'i1',
      card: scull,
      played_at: '2026-11-20T10:00:00Z',
      effect_id: 'e1',
      blocks_questions: false,
    })
    const s = deriveCards([started, played, ev('effect_clear_requested', { effect_id: 'e1' }), ev('effect_clear_rejected', { effect_id: 'e1' })])
    expect(s.effects[0].status).toBe('active')
    expect(s.log.at(-1)?.text).toBe('SCULLING: hider picked Hiders. Seekers try again')
  })
})
