import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { teamNotices } from './notices'
import { deriveCards } from './state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, visibility: GameEvent['visibility'] = 'all', actor: string | null = null): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: actor,
  payload,
  created_at: '2026-11-20T10:00:00Z',
})
const card = (id: string, behaviour: string, params: Record<string, unknown> = {}, category = 'curse') => ({
  card_id: id,
  name: id.toUpperCase(),
  category,
  category_name: category,
  colour: '#EC353A',
  behaviour,
  text: `${id} text`,
  params,
  cast_cost: null,
  can_veto: true,
  copies: 1,
})
const sculling = card('sculling', 'until_cleared', { judge_question: 'Who drank quicker?', judge_accept: 'Seekers', judge_reject: 'Hiders' })
const bridge = card('bridge', 'until_cleared')
const events = [
  ev('game_started', { round: 1, deck: [sculling, bridge], hand_limit: 4 }),
  ev('card_played', { round: 1, instance_id: 'i1', card: sculling, effect_id: 'e1' }, 'all', 'hider'),
  ev('card_played', { round: 1, instance_id: 'i2', card: bridge, effect_id: 'e2' }, 'all', 'hider'),
  ev('effect_clear_rejected', { round: 1, effect_id: 'e1' }, 'all', 'hider'),
  ev('effect_cleared', { round: 1, effect_id: 'e2' }, 'all', 'hider'),
  ev('curse_vetoed', { round: 1, instance_id: 'i1', effect_id: 'e1', name: 'SCULLING', lock_s: 600, penalty: 'each seeker drinks' }, 'all', 'seeker'),
  ev('card_played', { round: 1, instance_id: 'i3', card: card('ban', 'question_ban', { count: 1 }, 'powerup'), bans: [{ label: 'Radar 1 km' }] }, 'all', 'hider'),
  ev('card_played', { round: 1, instance_id: 'i4', card: card('dup', 'powerup', { action: 'duplicate' }, 'powerup') }, 'hiders', 'hider'),
  ev('dice_rolled', { round: 1, instance_id: 'i2', name: 'BRIDGE', dice: [3, 4], total: 7 }, 'all', 'seeker'),
  ev('effect_cleared', { round: 1, effect_id: 'e2', override_id: 'o1' }, 'all', 'host'),
]
const cards = deriveCards(events)

describe('teamNotices', () => {
  it("seekers hear the hider's verdict, public cards and others' dice", () => {
    const n = teamNotices(events, cards, 'seekers', 'seeker')
    expect(n.map((x) => [x.eyebrow, x.title])).toEqual([
      ['Hiders picked Hiders', "SCULLING isn't cleared"],
      ['Hiders confirmed', 'BRIDGE is cleared'],
      ['The hiders played a card', 'BAN'],
    ])
    expect(n[2].body).toBe('Banned: Radar 1 km.')
  })

  it('hiders hear vetoes and dice, never their own moves', () => {
    const n = teamNotices(events, cards, 'hiders', 'hider')
    expect(n.map((x) => x.eyebrow)).toEqual(['Seekers vetoed a curse', 'Dice rolled'])
    expect(n[0].body).toBe("They're locked at a bar for 10 min, each seeker drinks")
    expect(n[1].body).toBe('Rolled 3 + 4 = 7')
  })

  it('hiders hear Not applicable', () => {
    const more = [...events, ev('curse_checked', { round: 1, effect_id: 'e2', applies: false, not_applicable: true }, 'all', 'seeker')]
    const n = teamNotices(more, deriveCards(more), 'hiders', 'hider')
    expect(n.at(-1)).toMatchObject({ eyebrow: 'Seekers tapped Not applicable', title: 'BRIDGE' })
  })
})
