/** One round trip to server_time(): local send time, server time, local receive time (ms). */
export interface ClockSample {
  sentAt: number
  serverAt: number
  receivedAt: number
}

/**
 * Server clock minus local clock, in ms. Uses the sample with the shortest round trip
 * (least network noise) and assumes the server read its clock halfway through it.
 */
export function estimateOffset(samples: readonly ClockSample[]): number | null {
  let best: ClockSample | null = null
  for (const s of samples) {
    if (s.receivedAt < s.sentAt) continue
    if (!best || s.receivedAt - s.sentAt < best.receivedAt - best.sentAt) best = s
  }
  if (!best) return null
  return Math.round(best.serverAt - (best.sentAt + best.receivedAt) / 2)
}

/** Keeps the most recent samples and the current offset estimate. */
export class ServerClock {
  private samples: ClockSample[] = []
  private offset = 0
  private readonly keep: number

  constructor(keep = 5) {
    this.keep = keep
  }

  get offsetMs(): number {
    return this.offset
  }

  get synced(): boolean {
    return this.samples.length > 0
  }

  add(sample: ClockSample): void {
    this.samples = [...this.samples, sample].slice(-this.keep)
    this.offset = estimateOffset(this.samples) ?? this.offset
  }

  /** Drop old samples, e.g. after the app was in the background (device clock may have jumped). */
  clear(): void {
    this.samples = []
  }

  /** Current server time in ms since epoch. Use this for every countdown. */
  now(localNow: number = Date.now()): number {
    return localNow + this.offset
  }
}
