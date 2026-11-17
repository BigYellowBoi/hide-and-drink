import { describe, expect, it } from 'vitest'
import { configGroups, defaultConfig, fromDisplay, parseLoose, setIn, toDisplay, unitFor } from './config'

describe('config fields', () => {
  it('flattens the default config into groups without meta keys', () => {
    const groups = configGroups(defaultConfig)
    const paths = groups.flatMap((g) => g.fields.map((f) => f.path.join('.')))
    expect(paths).toContain('hiding_zone.bar_radius_m')
    expect(paths).toContain('hiding_zone.station_zone.radius_m')
    expect(paths).toContain('hiding_period_s')
    expect(paths.some((p) => p.endsWith('todo') || p === 'schema_version')).toBe(false)
  })

  it('infers kinds and units from values and key suffixes', () => {
    const fields = configGroups({ a_s: 300, b_m: null, c: true, d: ['x'], e: null, f: 'text' }).flatMap((g) => g.fields)
    expect(fields.map((f) => [f.kind, f.unit])).toEqual([
      ['number', 'min'],
      ['number', 'km'],
      ['boolean', null],
      ['list', null],
      ['unset', null],
      ['text', null],
    ])
  })

  it('inherits the unit from a parent key', () => {
    const f = configGroups(defaultConfig)
      .flatMap((g) => g.fields)
      .find((x) => x.path.join('.') === 'answer_deadline_s.default')
    expect(f?.unit).toBe('min')
  })

  it('converts metres/seconds to km/min and back', () => {
    expect(unitFor('answer_deadline_s')).toBe('min')
    expect(toDisplay(300, 'min')).toBe(5)
    expect(fromDisplay(5, 'min')).toBe(300)
    expect(toDisplay(805, 'km')).toBe(0.805)
    expect(fromDisplay(0.1, 'km')).toBe(100)
  })

  it('sets nested values without mutating', () => {
    const before = { a: { b: 1 }, c: 2 }
    const after = setIn(before, ['a', 'b'], 3)
    expect(after).toEqual({ a: { b: 3 }, c: 2 })
    expect(before.a.b).toBe(1)
  })

  it('parses loose text', () => {
    expect(parseLoose('')).toBeNull()
    expect(parseLoose('true')).toBe(true)
    expect(parseLoose('12')).toBe(12)
    expect(parseLoose('hi')).toBe('hi')
  })
})
