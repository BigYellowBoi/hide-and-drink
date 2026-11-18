/**
 * Countdown helpers shared by every timer on screen (main clock, answer ring, curse bars,
 * veto locks). Times are server ms (see sync/clock.ts).
 */

/** Under this, a countdown turns amber. */
export const SOON_MS = 60_000
/** Under this, it pulses. */
export const FINAL_MS = 10_000

export type TimerTone = 'ok' | 'soon' | 'final' | 'late'

export function timerTone(leftMs: number): TimerTone {
  if (leftMs <= 0) return 'late'
  if (leftMs <= FINAL_MS) return 'final'
  if (leftMs <= SOON_MS) return 'soon'
  return 'ok'
}

/**
 * Wait until the next whole tick of server time (plus a few ms), so every phone's digits
 * change together and a countdown never skips or repeats a second.
 */
export function msToNextTick(serverNow: number, tickMs: number): number {
  const into = ((serverNow % tickMs) + tickMs) % tickMs
  return tickMs - into + 5
}

/**
 * The alert threshold (ms left) a countdown passed between two readings, or null. With
 * several passed at once (the phone was asleep), only the last one counts, so a phone
 * that wakes up after the deadline buzzes once, not for every threshold it slept through.
 */
export function crossedThreshold(prevLeftMs: number | null, leftMs: number, thresholds: readonly number[]): number | null {
  if (prevLeftMs === null) return null
  let hit: number | null = null
  for (const t of thresholds) if (prevLeftMs > t && leftMs <= t) hit = hit === null ? t : Math.min(hit, t)
  return hit
}

/** "+1:05" for time past a deadline. */
export function formatOverdue(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  return `+${m}:${String(total % 60).padStart(2, '0')}`
}

/** Vibration pattern per threshold: a short buzz at a minute left, a long one at zero. */
export function buzzFor(threshold: number): number[] {
  return threshold <= 0 ? [300, 100, 300] : [120]
}
