import { describe, expect, it } from 'vitest'
import { failures, percentile, summarise } from './stats.ts'

describe('latency stats', () => {
  it('uses nearest-rank percentiles', () => {
    const xs = Array.from({ length: 100 }, (_, i) => i + 1) // 1..100
    expect(percentile(xs, 50)).toBe(50)
    expect(percentile(xs, 95)).toBe(95)
    expect(percentile(xs, 100)).toBe(100)
    expect(percentile([7], 95)).toBe(7)
    expect(percentile([], 95)).toBeNaN()
  })

  it('does not reorder the input', () => {
    const xs = [3, 1, 2]
    percentile(xs, 50)
    expect(xs).toEqual([3, 1, 2])
  })

  it('passes when p95 is within the limit', () => {
    const s = summarise([...Array(95).fill(100), ...Array(5).fill(5000)])
    expect(s.p95).toBe(100)
    expect(failures(s, 1000)).toEqual([])
  })

  it('fails when p95 is over the limit', () => {
    const s = summarise([...Array(90).fill(100), ...Array(10).fill(1500)])
    expect(failures(s, 1000)).toEqual(['p95 1500 ms > 1000 ms'])
  })

  it('fails on missing broadcasts and on no samples', () => {
    expect(failures(summarise([100], 2), 1000)).toEqual(['2 broadcast(s) never arrived'])
    expect(failures(summarise([]), 1000)).toEqual(['no samples', 'p95 NaN ms > 1000 ms'])
  })
})
