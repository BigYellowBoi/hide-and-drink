/** Latency statistics for the harness. Pure, so it is unit tested. */

export interface Summary {
  count: number
  missing: number
  p50: number
  p95: number
  p99: number
  max: number
}

/** Nearest-rank percentile (p in 0..100) of samples in ms. NaN when empty. */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return Number.NaN
  const sorted = [...samples].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function summarise(samples: readonly number[], missing = 0): Summary {
  return {
    count: samples.length,
    missing,
    p50: percentile(samples, 50),
    p95: percentile(samples, 95),
    p99: percentile(samples, 99),
    max: samples.length ? Math.max(...samples) : Number.NaN,
  }
}

/**
 * Why the run failed, or [] if it passed. A broadcast that never arrived counts as a
 * failure: the app would recover it by fetch, but the harness measures delivery.
 */
export function failures(s: Summary, p95LimitMs: number): string[] {
  const out: string[] = []
  if (s.count === 0) out.push('no samples')
  if (s.missing > 0) out.push(`${s.missing} broadcast(s) never arrived`)
  if (!(s.p95 <= p95LimitMs)) out.push(`p95 ${Math.round(s.p95)} ms > ${p95LimitMs} ms`)
  return out
}
