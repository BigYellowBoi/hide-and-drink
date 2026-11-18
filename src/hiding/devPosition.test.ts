import { describe, expect, it } from 'vitest'
import { defaultConfig } from '../lobby/config'
import { fakeFix, fakePositionKey, isDevMode, parseFakeFix, serializeFakeFix } from './devPosition'

describe('dev/playtest mode', () => {
  it('is off by default and only on for exactly true', () => {
    expect(defaultConfig.dev_mode).toBe(false)
    expect(isDevMode(defaultConfig)).toBe(false)
    expect(isDevMode({})).toBe(false)
    expect(isDevMode({ dev_mode: 'true' })).toBe(false)
    expect(isDevMode({ dev_mode: true })).toBe(true)
  })

  it('round-trips a placed point as a fake fix with no accuracy', () => {
    const fix = fakeFix(153.025, -27.47, 1000)
    expect(fix).toEqual({ lng: 153.025, lat: -27.47, accuracyM: null, at: 1000, fake: true })
    expect(parseFakeFix(serializeFakeFix(fix))).toEqual(fix)
  })

  it('ignores missing or bad stored points', () => {
    expect(parseFakeFix(null)).toBeNull()
    expect(parseFakeFix('nope')).toBeNull()
    expect(parseFakeFix('{"lng":"1","lat":2}')).toBeNull()
    expect(parseFakeFix('{"lng":200,"lat":2}')).toBeNull()
  })

  it('keys points per game and player', () => {
    expect(fakePositionKey('g1', 'u1')).not.toBe(fakePositionKey('g1', 'u2'))
    expect(fakePositionKey('g1', 'u1')).not.toBe(fakePositionKey('g2', 'u1'))
  })
})
