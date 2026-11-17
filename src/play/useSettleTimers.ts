import { useEffect } from 'react'
import type { GameSync } from '../sync/engine'
import { dueTimer, type PlayState } from './state'

/**
 * When a countdown this phone shows runs out (hiding period, answer deadline), ask the
 * server to settle it. Every phone does this; the server decides from its own clock and
 * logs each outcome once. A small random delay spreads the phones' calls out, and it
 * tries again every 10 s while still due (a failed call, or this clock running early).
 */
export function useSettleTimers(sync: GameSync, play: PlayState, canAct: boolean, now: number) {
  const due = canAct ? dueTimer(play, now) : null
  const retryTick = Math.floor(now / 10_000)

  useEffect(() => {
    if (!due) return
    const t = setTimeout(() => {
      sync.action('settle_timers', {}, { fresh: false }).catch(() => {
        /* tried again on the next tick */
      })
    }, Math.random() * 1500)
    return () => clearTimeout(t)
  }, [due, sync, retryTick])
}
