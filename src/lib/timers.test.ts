import { describe, expect, it } from 'vitest'
import { buzzFor, crossedThreshold, formatOverdue, msToNextTick, timerTone } from './timers'

describe('timers', () => {
  it('tones a countdown by time left', () => {
    expect(timerTone(120_000)).toBe('ok')
    expect(timerTone(60_000)).toBe('soon')
    expect(timerTone(9_000)).toBe('final')
    expect(timerTone(0)).toBe('late')
    expect(timerTone(-5)).toBe('late')
  })

  it('waits for the next whole second of server time', () => {
    expect(msToNextTick(10_000, 1000)).toBe(1005)
    expect(msToNextTick(10_250, 1000)).toBe(755)
    expect(msToNextTick(10_999, 1000)).toBe(6)
  })

  it('reports a threshold once, when it is crossed', () => {
    const th = [60_000, 0]
    expect(crossedThreshold(null, 59_000, th)).toBeNull()
    expect(crossedThreshold(61_000, 60_000, th)).toBe(60_000)
    expect(crossedThreshold(60_000, 59_000, th)).toBeNull()
    expect(crossedThreshold(1_000, 0, th)).toBe(0)
    expect(crossedThreshold(0, -1_000, th)).toBeNull()
  })

  it('reports only the last threshold after a sleep', () => {
    expect(crossedThreshold(120_000, -5_000, [60_000, 0])).toBe(0)
  })

  it('formats time past a deadline', () => {
    expect(formatOverdue(0)).toBe('+0:00')
    expect(formatOverdue(65_400)).toBe('+1:05')
  })

  it('buzzes longer at zero', () => {
    expect(buzzFor(0).length).toBeGreaterThan(buzzFor(60_000).length)
  })
})
