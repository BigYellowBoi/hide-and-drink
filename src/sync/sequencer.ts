import type { Audience, GameEvent } from './types'

/**
 * Applies events strictly in seq order and detects gaps. Pure: no network, no timers.
 *
 * Events can arrive out of order (two topics), twice (broadcast + fetch) or not at all
 * (dropped broadcast). Seqs are contiguous per game but each team skips the other team's
 * private events, so "next" means: nothing this audience can see lies between the last
 * applied seq and this one. Broadcasts say that via prev_seq; fetched rows prove it by
 * being a complete list.
 */
export class EventSequencer {
  private last = 0
  private readonly buffer = new Map<number, GameEvent>()
  private audience: Audience
  private readonly apply: (event: GameEvent) => void

  constructor(audience: Audience, apply: (event: GameEvent) => void) {
    this.audience = audience
    this.apply = apply
  }

  /** Seq of the last applied event. Send this as last_seen_seq. */
  get lastSeq(): number {
    return this.last
  }

  /** True while an event is held back waiting for a missing predecessor. */
  get hasGap(): boolean {
    return this.buffer.size > 0
  }

  /** Forget everything (e.g. the player's team changed, so visibility changed). */
  reset(audience: Audience): void {
    this.audience = audience
    this.last = 0
    this.buffer.clear()
  }

  /**
   * Handle a live event. Returns 'applied' (it and any unblocked buffered events were
   * applied), 'duplicate' (already applied), or 'buffered' (a predecessor is missing:
   * fetch events after lastSeq).
   */
  receive(event: GameEvent): 'applied' | 'duplicate' | 'buffered' {
    if (event.seq <= this.last || this.buffer.has(event.seq)) return 'duplicate'
    if (!this.isNext(event)) {
      this.buffer.set(event.seq, event)
      return 'buffered'
    }
    this.applyOne(event)
    this.drain()
    return 'applied'
  }

  /**
   * Handle the result of fetching every visible event with seq > `after`. The fetch is a
   * complete view up to its highest seq, so everything up to there can be applied even
   * across seqs this audience can't see. Buffered events beyond it stay held if still
   * not contiguous. Returns true if a gap remains.
   */
  applyFetched(after: number, events: readonly GameEvent[]): boolean {
    let complete = after
    for (const e of events) complete = Math.max(complete, e.seq)

    const merged = new Map<number, GameEvent>()
    for (const e of events) merged.set(e.seq, e)
    for (const [seq, e] of this.buffer) if (seq <= complete && !merged.has(seq)) merged.set(seq, e)

    for (const seq of [...merged.keys()].sort((a, b) => a - b)) {
      if (seq > this.last) this.applyOne(merged.get(seq)!)
      this.buffer.delete(seq)
    }
    this.drain()
    return this.hasGap
  }

  private isNext(event: GameEvent): boolean {
    const prev = event.prev_seq?.[this.audience]
    if (typeof prev === 'number') return prev <= this.last
    return event.seq === this.last + 1
  }

  private applyOne(event: GameEvent): void {
    this.last = event.seq
    this.apply(event)
  }

  private drain(): void {
    while (this.buffer.size > 0) {
      const seq = Math.min(...this.buffer.keys())
      const event = this.buffer.get(seq)!
      if (seq <= this.last) {
        this.buffer.delete(seq)
      } else if (this.isNext(event)) {
        this.buffer.delete(seq)
        this.applyOne(event)
      } else {
        return
      }
    }
  }
}
