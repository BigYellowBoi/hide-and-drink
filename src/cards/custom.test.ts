import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import {
  activePlagueSpots,
  bankDrinks,
  castChoice,
  castMedia,
  clearable,
  countsOwed,
  deriveCards,
  drinkPerQuestion,
  hiderCount,
  parseCard,
  zoneMultiplier,
} from './state'
import { teamNotices } from './notices'
import { deriveHiding, grownZone, hidingZone } from '../hiding/state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, visibility: GameEvent['visibility'] = 'all', at = '2026-11-27T10:00:00Z'): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: null,
  payload: { round: 1, ...payload },
  created_at: at,
})

const card = (id: string, behaviour: string, params: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  card_id: id,
  name: id,
  category: 'curse',
  category_name: 'Curse',
  colour: '#EC353A',
  behaviour,
  text: `${id} text`,
  params,
  cast_cost: 'free',
  can_veto: true,
  copies: 1,
  ...extra,
})

const brothel = card('brothel', 'until_cleared', {
  proof: 'photo',
  hider_proof: 'photo',
  blocks_questions: true,
  hider_count: { prompt: 'People in the call?', per: 2, unit: 'shot' },
})
const exchange = card('exchange', 'until_cleared', {
  proof: 'video',
  hider_proof: 'photo',
  hider_proof_optional: true,
  hider_count: { prompt: 'Standard drinks?', unit: 'standard drink', time_s: 300 },
})
const mine = card('mine', 'until_cleared', { mine: true, proof: 'photo' })
const happy = card('happy', 'timed', { duration_s: 1200, drink_per_question: 'drink' })
const plague = card('plague', 'timed', { duration_s: 1800, plague_radius_m: 250 })
const home = card('home', 'text', { zone_radius_multiplier: 1.5 }, { can_veto: false })
const bank = card('bank', 'text', { bank_time_bonuses: { minutes_per: 4, unit: 'drink' } })
const beer = card('beer', 'text', { hider_count: { prompt: 'Drinks?', time_s: 300, reward: 'extra_draw', unit: 'card' } }, { category: 'drink' })
const deck = [brothel, exchange, mine, happy, plague, home, bank, beer]
const started = ev('game_started', { deck, hand_limit: 6 })
const played = (c: ReturnType<typeof card>, instance: string, extra: Record<string, unknown> = {}, at?: string) =>
  ev('card_played', { instance_id: instance, card: c, played_at: at ?? '2026-11-27T10:00:00Z', ...extra }, 'all', at)

describe('hider counts', () => {
  it('reads params.hider_count', () => {
    expect(hiderCount(parseCard(brothel)!)).toEqual({ prompt: 'People in the call?', per: 2, unit: 'shot', timeS: null, reward: null })
    expect(hiderCount(parseCard(beer)!)?.timeS).toBe(300)
    expect(hiderCount(parseCard(mine)!)).toBeNull()
  })

  it('a count is owed until sent, then the seekers know what to drink', () => {
    const p = played(brothel, 'b1', { effect_id: 'e1', blocks_questions: true })
    expect(countsOwed(deriveCards([started, p])).map((x) => x.instanceId)).toEqual(['b1'])
    const set = ev('card_count_set', { instance_id: 'b1', effect_id: 'e1', count: 5, amount: 2, unit: 'shot', name: 'brothel' })
    const s = deriveCards([started, p, set])
    expect(countsOwed(s)).toEqual([])
    expect(s.counts.b1).toEqual({ count: 5, amount: 2, unit: 'shot', reward: null })
    expect(s.log.at(-1)?.text).toBe('brothel: hiders counted 5, seekers drink 2 shots')
    const notice = teamNotices([set], s, 'seekers', null)
    expect(notice[0].body).toBe('Drink 2 shots (they counted 5).')
    expect(teamNotices([set], s, 'hiders', null)).toEqual([])
  })

  it('no count is owed for a vetoed curse', () => {
    const p = played(brothel, 'b1', { effect_id: 'e1' })
    const veto = ev('curse_vetoed', { instance_id: 'b1', effect_id: 'e1', lock_s: 600 })
    expect(countsOwed(deriveCards([started, p, veto]))).toEqual([])
  })

  it('Beer Bonus adds extra cards to the next reward until an answer spends them', () => {
    const p = played(beer, 'k1')
    const set = ev('card_count_set', { instance_id: 'k1', count: 3, amount: 3, unit: 'card', reward: 'extra_draw' })
    const s = deriveCards([started, p, set])
    expect(s.nextExtraDraw).toBe(3)
    expect(s.log.at(-1)?.text).toBe('beer: hiders counted 3, 3 extra cards on the next reward')
    expect(teamNotices([set], s, 'seekers', null)).toEqual([])
    expect(deriveCards([started, p, set, ev('question_answered', { question_id: 'q' })]).nextExtraDraw).toBe(0)
  })

  it('an optional first photo is not asked for at cast', () => {
    expect(castMedia(parseCard(exchange)!, true).setup).toBeNull()
    expect(castMedia(parseCard(brothel)!, true).setup).toBe('photo')
    const p = played(exchange, 'x1', { effect_id: 'e2' })
    const due = ev('proof_due', { proof_id: 'p1', effect_id: 'e2', team: 'hiders', kind: 'setup', optional: true })
    expect(deriveCards([started, p, due]).proofs[0].optional).toBe(true)
  })
})

describe('Minefield', () => {
  it('casts with a question pick and only clears once it goes off', () => {
    expect(castChoice(parseCard(mine)!)).toEqual({ kind: 'mine' })
    const p = played(mine, 'm1', { effect_id: 'e3', blocks_questions: false })
    const set = ev('mine_set', { effect_id: 'e3', type: 'radar', option_id: '2km', label: '2 km' }, 'hiders')
    const s = deriveCards([started, p, set])
    const e = s.effects[0]
    expect(e.mineLabel).toBe('2 km')
    expect(clearable(e, Date.parse('2026-11-27T10:05:00Z'))).toBe(false)
    const boom = ev('mine_triggered', { effect_id: 'e3', question_id: 'q9', label: '2 km', blocks_questions: true })
    const t = deriveCards([started, p, set, boom])
    expect(t.effects[0].mineTriggered).toBe('2 km')
    expect(t.effects[0].blocksQuestions).toBe(true)
    expect(clearable(t.effects[0], Date.parse('2026-11-27T10:05:00Z'))).toBe(true)
    expect(teamNotices([boom], t, 'seekers', null)[0].eyebrow).toBe('Mine!')
  })
})

describe('Happy Hour and Plagued World', () => {
  it('a drink per question while it runs', () => {
    const p = played(happy, 'h1', { effect_id: 'e4', ends_at: '2026-11-27T10:20:00Z', duration_s: 1200 })
    const s = deriveCards([started, p])
    expect(drinkPerQuestion(s, Date.parse('2026-11-27T10:10:00Z'))).toHaveLength(1)
    expect(drinkPerQuestion(s, Date.parse('2026-11-27T10:21:00Z'))).toHaveLength(0)
  })

  it('plague spots last until the curse ends', () => {
    const p = played(plague, 'p1', { effect_id: 'e5', ends_at: '2026-11-27T10:30:00Z', duration_s: 1800 })
    const spot = ev('plague_spot', { effect_id: 'e5', question_id: 'q1', lng: 153.02, lat: -27.47, radius_m: 250, ends_at: '2026-11-27T10:30:00Z' })
    const s = deriveCards([started, p, spot])
    expect(activePlagueSpots(s, Date.parse('2026-11-27T10:10:00Z'))).toHaveLength(1)
    expect(activePlagueSpots(s, Date.parse('2026-11-27T10:31:00Z'))).toHaveLength(0)
  })
})

describe('Prosperous Home', () => {
  it('grows the bar circle and freeze radius, unless vetoed', () => {
    const bar = ev('bar_chosen', { venue_id: 'v', name: 'Bar', lng: 153, lat: -27, radius_m: 100 }, 'hiders')
    const p = played(home, 'z1')
    expect(deriveHiding([bar, p], 1).bar?.radiusM).toBe(150)
    expect(zoneMultiplier(deriveCards([started, p]))).toBe(1.5)
    const zone = grownZone(hidingZone({ hiding_zone: { bar_radius_m: 100, freeze_when_seeker_within_m: 100 } }), 1.5)
    expect(zone.freezeRadiusM).toBe(150)
    const veto = ev('curse_vetoed', { instance_id: 'z1', lock_s: 600 })
    expect(deriveHiding([bar, p, veto], 1).bar?.radiusM).toBe(100)
  })
})

describe('Time Bank', () => {
  it('picks time bonuses and rounds the drinks down', () => {
    expect(castChoice(parseCard(bank)!)).toEqual({ kind: 'bonuses' })
    expect(bankDrinks(6, 4)).toBe(1)
    expect(bankDrinks(8, 4)).toBe(2)
    expect(bankDrinks(2, 4)).toBe(0)
  })

  it('banked bonuses leave the hand', () => {
    const drawn = ev(
      'cards_drawn',
      { draw_id: 'd', pick: 2, cards: [{ instance_id: 'r1', card_id: 'bank' }, { instance_id: 'r2', card_id: 'home' }] },
      'hiders',
    )
    const kept = ev('cards_kept', { draw_id: 'd', kept: ['r1', 'r2'], discarded: [] }, 'hiders')
    const banked = ev('bonuses_banked', { instance_id: 'b', discarded: ['r2'], minutes: 6, amount: 1 }, 'hiders')
    expect(deriveCards([started, drawn, kept, banked]).hand.map((c) => c.instanceId)).toEqual(['r1'])
  })
})
