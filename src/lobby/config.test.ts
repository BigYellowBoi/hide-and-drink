import { describe, expect, it } from 'vitest'
import {
  changedSettings,
  clampToInput,
  defaultConfig,
  formatValue,
  fromDisplay,
  isChanged,
  NOT_SETTINGS,
  resetAll,
  resetSetting,
  setIn,
  SETTINGS,
  toDisplay,
  validateConfig,
  valueOf,
  type Setting,
} from './config'

const byId = (id: string): Setting => {
  const s = SETTINGS.find((x) => x.id === id)
  if (!s) throw new Error(id)
  return s
}

/** Dotted paths of every leaf (non-object value) in a config. */
function leaves(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? leaves(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  )
}

describe('settings schema', () => {
  it('covers every key in data/config.json as a setting or a listed non-setting', () => {
    const known = new Set([...SETTINGS.map((s) => s.id), ...NOT_SETTINGS])
    expect(leaves(defaultConfig).filter((k) => !known.has(k))).toEqual([])
  })

  it('hides notes and free text from the editor', () => {
    const ids = SETTINGS.map((s) => s.id)
    for (const k of ['todo', 'schema_version', 'cast_costs', 'late_answer_penalty', 'veto.penalty', 'deck']) {
      expect(ids).not.toContain(k)
    }
  })

  it('gives every setting a label, a one-line description, info and a group', () => {
    for (const s of SETTINGS) {
      expect(s.label.length).toBeGreaterThan(0)
      expect(s.description).not.toMatch(/\n/)
      expect(s.info.length).toBeGreaterThan(0)
      if (s.input.kind === 'number') expect(s.input.min).toBeLessThan(s.input.max)
    }
  })

  it('has one answer time override per question type', () => {
    expect(SETTINGS.filter((s) => s.id.startsWith('answer_deadline_s.') && s.id !== 'answer_deadline_s.default')).toHaveLength(7)
  })

  it('accepts the defaults', () => {
    expect(validateConfig(defaultConfig)).toEqual([])
    expect(changedSettings(defaultConfig)).toEqual([])
  })

  it('reads missing keys as the default', () => {
    expect(valueOf(byId('hand_limit'), {})).toBe(6)
    expect(valueOf(byId('answer_deadline_s.radar'), {})).toBeNull()
    expect(validateConfig({})).toEqual([])
  })
})

describe('validation', () => {
  it('rejects numbers out of range with a readable message', () => {
    const errs = validateConfig(setIn(defaultConfig, ['hiding_period_s'], 60))
    expect(errs).toEqual([{ id: 'hiding_period_s', message: 'Hiding period must be between 5 min and 180 min.' }])
  })

  it('rejects distances out of range in km', () => {
    const errs = validateConfig(setIn(defaultConfig, ['hiding_zone', 'bar_radius_m'], 5000))
    expect(errs[0].message).toBe('Hiding zone radius must be between 0.025 km and 0.5 km.')
  })

  it('rejects wrong types', () => {
    const c = setIn(setIn(defaultConfig, ['hand_limit'], 'six'), ['photo_proof_for_drinks'], 'yes')
    expect(validateConfig(c)).toEqual([
      { id: 'hand_limit', message: 'Hand limit needs a number.' },
      { id: 'photo_proof_for_drinks', message: 'Photo proof for drinks must be on or off.' },
    ])
  })

  it('rejects fractional counts', () => {
    expect(validateConfig(setIn(defaultConfig, ['hand_limit'], 2.5))[0].message).toBe('Hand limit must be a whole number.')
  })

  it('allows optional settings to be unset but not a required one', () => {
    expect(validateConfig(setIn(defaultConfig, ['answer_deadline_s', 'photos'], null))).toEqual([])
    expect(validateConfig(setIn(defaultConfig, ['answer_deadline_s', 'default'], null))[0].message).toBe(
      'Answer time needs a number.',
    )
  })

  it('reports every bad setting at once', () => {
    const c = setIn(setIn(defaultConfig, ['veto', 'base_lock_s'], -60), ['seeker_location_interval_s'], 1)
    expect(validateConfig(c).map((e) => e.id)).toEqual(['veto.base_lock_s', 'seeker_location_interval_s'])
  })
})

describe('defaults and reset', () => {
  it('marks settings that differ from the defaults', () => {
    const c = setIn(defaultConfig, ['hand_limit'], 8)
    expect(isChanged(byId('hand_limit'), c)).toBe(true)
    expect(changedSettings(c).map((s) => s.id)).toEqual(['hand_limit'])
  })

  it('resets one setting and keeps everything else', () => {
    const c = setIn(setIn(defaultConfig, ['hand_limit'], 8), ['veto', 'step_s'], 120)
    const r = resetSetting(c, byId('veto.step_s'))
    expect(changedSettings(r).map((s) => s.id)).toEqual(['hand_limit'])
    expect((r.veto as Record<string, unknown>).penalty).toBe('each seeker drinks')
  })

  it('resets all settings but keeps the deck and notes', () => {
    const c = { ...setIn(defaultConfig, ['hand_limit'], 8), deck: { veto: 3 }, extra_key: 1 }
    const r = resetAll(c)
    expect(changedSettings(r)).toEqual([])
    expect(r.deck).toEqual({ veto: 3 })
    expect(r.extra_key).toBe(1)
    expect(r.todo).toBe(defaultConfig.todo)
  })
})

describe('display', () => {
  it('formats values in display units', () => {
    expect(formatValue(byId('hiding_period_s'), 3600)).toBe('60 min')
    expect(formatValue(byId('hiding_zone.bar_radius_m'), 100)).toBe('0.1 km')
    expect(formatValue(byId('seeker_location_interval_s'), 20)).toBe('20 s')
    expect(formatValue(byId('dev_mode'), false)).toBe('Off')
    expect(formatValue(byId('answer_deadline_s.photos'), null)).toBe('Usual')
  })

  it('snaps to the step and range', () => {
    expect(clampToInput(byId('hiding_period_s'), 3700)).toBe(3600)
    expect(clampToInput(byId('hiding_period_s'), 99999)).toBe(10800)
  })

  it('converts metres/seconds to km/min and back', () => {
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
})
