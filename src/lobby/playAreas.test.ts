import { describe, expect, it } from 'vitest'
import { madeBy, type PlayAreaSummary } from './playAreas'

const area = (over: Partial<PlayAreaSummary>): PlayAreaSummary => ({
  id: 'a',
  name: 'Map',
  city: 'brisbane',
  createdBy: 'u1',
  creatorName: 'Amy',
  createdAt: Date.parse('2026-11-17T03:00:00Z'),
  area: null,
  ...over,
})

describe('madeBy', () => {
  it('names the creator and the day', () => {
    expect(madeBy(area({}))).toBe('Amy · 17 Nov')
  })
  it('labels built-in areas', () => {
    expect(madeBy(area({ createdBy: null, creatorName: null }))).toBe('Built in')
  })
  it('copes with a missing name or date', () => {
    expect(madeBy(area({ creatorName: null, createdAt: Number.NaN }))).toBe('Someone')
  })
})
