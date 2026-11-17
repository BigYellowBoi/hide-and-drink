import { describe, expect, it } from 'vitest'
import { ServerClock, estimateOffset } from './clock'

describe('estimateOffset', () => {
  it('assumes the server read its clock at the midpoint of the round trip', () => {
    expect(estimateOffset([{ sentAt: 1000, serverAt: 6100, receivedAt: 1200 }])).toBe(5000)
  })

  it('uses the sample with the shortest round trip', () => {
    expect(
      estimateOffset([
        { sentAt: 0, serverAt: 9000, receivedAt: 2000 }, // slow, noisy
        { sentAt: 3000, serverAt: 3050 - 400, receivedAt: 3100 }, // fast: offset -400
      ]),
    ).toBe(-400)
  })

  it('returns null with no usable samples', () => {
    expect(estimateOffset([])).toBeNull()
    expect(estimateOffset([{ sentAt: 10, serverAt: 0, receivedAt: 5 }])).toBeNull()
  })
})

describe('ServerClock', () => {
  it('corrects local time by the offset', () => {
    const c = new ServerClock()
    c.add({ sentAt: 0, serverAt: 10_050, receivedAt: 100 })
    expect(c.offsetMs).toBe(10_000)
    expect(c.now(500)).toBe(10_500)
  })

  it('keeps only recent samples', () => {
    const c = new ServerClock(2)
    c.add({ sentAt: 0, serverAt: 1005, receivedAt: 10 }) // best RTT, offset 1000
    c.add({ sentAt: 0, serverAt: 2050, receivedAt: 100 })
    c.add({ sentAt: 0, serverAt: 3045, receivedAt: 90 })
    expect(c.offsetMs).toBe(3000)
  })
})
