import { describe, expect, it } from 'vitest'
import { behaviours, cards, categories, copiesByCategory, deckSize, questionTypes } from './seed'

describe('seed card data', () => {
  it('has the 81-card first-game deck', () => {
    expect(deckSize()).toBe(81)
  })

  it('splits copies across categories as in the first game', () => {
    expect(copiesByCategory()).toEqual({ powerup: 12, time_bonus: 42, drink: 5, curse: 22 })
  })

  it('uses only known categories and behaviours', () => {
    const catIds = new Set(categories.map((c) => c.id))
    for (const c of cards) {
      expect(catIds.has(c.category), c.id).toBe(true)
      expect(behaviours.includes(c.behaviour), c.id).toBe(true)
    }
  })

  it('has unique card ids', () => {
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length)
  })

  it('has text for every card in the deck', () => {
    for (const c of cards.filter((c) => c.active && c.copies > 0)) {
      expect(c.text, c.id).toBeTruthy()
    }
  })

  it('gives every curse a veto flag', () => {
    for (const c of cards.filter((c) => c.category === 'curse')) {
      expect(typeof c.can_veto, c.id).toBe('boolean')
    }
  })
})

describe('seed question data', () => {
  it('has all seven question types with draw >= pick', () => {
    expect(questionTypes.map((q) => q.type)).toEqual([
      'matching',
      'measuring',
      'thermometer',
      'radar',
      'tentacles',
      'photos',
      'bonus',
    ])
    for (const q of questionTypes) expect(q.reward.draw).toBeGreaterThanOrEqual(q.reward.pick)
  })
})
