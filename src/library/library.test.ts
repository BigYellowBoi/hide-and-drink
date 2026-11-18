import { describe, expect, it } from 'vitest'
import {
  compactDeck,
  copiesIn,
  deckTotals,
  effectiveDeck,
  matchesPreset,
  parseCard,
  parseDeck,
  parsePreset,
  presetDeck,
  toCardDef,
  withCopies,
  type LibraryCard,
} from './library'
import { buildParams, otherParams, paramProblem } from './params'

const card = (id: string, category: string, copies: number, active = true): LibraryCard => ({
  ...parseCard({ id, name: id, category_id: category, behaviour: 'text', default_copies: copies, active }),
})

const cards = [card('veto', 'powerup', 2), card('bonus', 'time_bonus', 5), card('old', 'curse', 3, false), card('bridge', 'curse', 1)]

describe('library rows', () => {
  it('parses a card row', () => {
    const c = parseCard({
      id: 'x', name: 'X', category_id: 'curse', behaviour: 'timed', body: 'Do it', params: { duration_s: 60 },
      cast_cost: 'shot', can_veto: true, default_copies: 2, sort: 4, active: true, updated_by_name: 'Amy',
      updated_at: '2026-11-18T10:00:00.123456+00:00',
    })
    expect(c).toMatchObject({ category: 'curse', text: 'Do it', castCost: 'shot', canVeto: true, copies: 2, updatedByName: 'Amy' })
    expect(c.updatedAt).toBe('2026-11-18T10:00:00.123456+00:00')
  })

  it('parses presets and decks', () => {
    expect(parsePreset({ id: 'p', name: 'Defaults', deck: null, created_by: null })).toMatchObject({ deck: null, builtIn: true })
    expect(parsePreset({ id: 'p', name: 'Mine', deck: { veto: 1 }, created_by: 'u' }).builtIn).toBe(false)
    expect(parseDeck({ veto: 2, bad: -1, half: 1.5, s: '3' })).toEqual({ veto: 2 })
    expect(parseDeck(null)).toBeNull()
  })

  it('makes a CardDef with the category colour', () => {
    const def = toCardDef(cards[0], [{ id: 'powerup', name: 'Powerup', colour: '#9B8CF5', sort: 0, active: true }])
    expect(def).toMatchObject({ categoryName: 'Powerup', colour: '#9B8CF5', copies: 2 })
  })
})

describe('deck', () => {
  it('uses library defaults until the host sets a deck', () => {
    expect(copiesIn(null, cards[0])).toBe(2)
    expect(copiesIn({ bonus: 1 }, cards[0])).toBe(0)
    expect(deckTotals(null, cards)).toEqual({ total: 8, byCategory: { powerup: 2, time_bonus: 5, curse: 1 } })
  })

  it('retired cards never count', () => {
    expect(deckTotals({ old: 9, veto: 1 }, cards).total).toBe(1)
    expect(effectiveDeck(null, cards)).not.toHaveProperty('old')
  })

  it('a first tap turns the defaults into an explicit deck', () => {
    expect(withCopies(null, cards, 'veto', 3)).toEqual({ veto: 3, bonus: 5, bridge: 1 })
    expect(withCopies({ veto: 1 }, cards, 'veto', -2)).toEqual({ veto: 0, bonus: 0, bridge: 0 })
    expect(withCopies({}, cards, 'veto', 500).veto).toBe(99)
  })

  it('applies and recognises presets', () => {
    const defaults = parsePreset({ id: 'd', name: 'Defaults', deck: null, created_by: null })
    const mine = parsePreset({ id: 'm', name: 'Mine', deck: { veto: 4, old: 2 }, created_by: 'u' })
    expect(presetDeck(defaults, cards)).toBeNull()
    expect(presetDeck(mine, cards)).toEqual({ veto: 4, bonus: 0, bridge: 0 })
    expect(matchesPreset(null, defaults, cards)).toBe(true)
    expect(matchesPreset({ veto: 2, bonus: 5, bridge: 1 }, defaults, cards)).toBe(true)
    expect(matchesPreset({ veto: 4 }, mine, cards)).toBe(true)
    expect(matchesPreset(null, mine, cards)).toBe(false)
  })

  it('saves only cards with copies', () => {
    expect(compactDeck({ veto: 2, bonus: 0 })).toEqual({ veto: 2 })
  })
})

describe('card params', () => {
  it('keeps only the fields for the behaviour, plus other keys', () => {
    expect(buildParams('timed', { duration_s: 600, followup_s: undefined, minutes: 4 }, { condition: 'x' })).toEqual({
      duration_s: 600,
      condition: 'x',
    })
    expect(buildParams('powerup', { action: 'veto', discard: 1, draw: 2 }, {})).toEqual({ action: 'veto' })
    expect(buildParams('powerup', { action: 'discard_draw', discard: 1, draw: 2 }, {})).toEqual({
      action: 'discard_draw',
      discard: 1,
      draw: 2,
    })
    expect(buildParams('until_cleared', { blocks_questions: false, drinks: [] }, {})).toEqual({})
  })

  it('splits off params the editor has no field for', () => {
    expect(otherParams({ duration_s: 1, radius_m: 150, utility: 'dice' })).toEqual({ radius_m: 150 })
  })

  it('flags what the server would refuse', () => {
    expect(paramProblem('timed', {})).toMatch(/Duration/)
    expect(paramProblem('timed', { duration_s: 60 })).toBeNull()
    expect(paramProblem('powerup', { action: 'discard_draw', discard: 1 })).toMatch(/Draw/)
    expect(paramProblem('powerup', { action: 'discard_draw', discard: 1, draw: 0 })).toMatch(/Draw/)
    expect(paramProblem('time_bonus', { minutes: 0 })).toMatch(/Minutes/)
    expect(paramProblem('text', { utility: 'wheel', wheel_options: ['a'] })).toMatch(/Wheel/)
    expect(paramProblem('text', { utility: 'dice', dice: 2 })).toBeNull()
  })
})
