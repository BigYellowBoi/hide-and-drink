import { useEffect, useRef } from 'react'
import { buzzFor, crossedThreshold, SOON_MS } from './timers'

const MINUTE_AND_ZERO = [SOON_MS, 0] as const

/**
 * Buzz the phone (where supported) when a countdown this phone cares about reaches a
 * minute left and when it runs out. leftMs null = no countdown. Never buzzes for a timer
 * that was already past a threshold when it first appeared.
 */
export function useTimerAlert(key: string | null, leftMs: number | null, thresholds: readonly number[] = MINUTE_AND_ZERO) {
  const prev = useRef<{ key: string | null; left: number | null }>({ key: null, left: null })
  useEffect(() => {
    const last = prev.current.key === key ? prev.current.left : null
    prev.current = { key, left: leftMs }
    if (key === null || leftMs === null) return
    const hit = crossedThreshold(last, leftMs, thresholds)
    if (hit !== null && typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      try {
        navigator.vibrate(buzzFor(hit))
      } catch {
        /* not allowed here */
      }
    }
  }, [key, leftMs, thresholds])
}
