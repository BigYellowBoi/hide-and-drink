import type { GameEvent } from '../sync/types'
import { pausedMs } from './move'

/** The hider's locked-in bar for a round (from the hider-only bar_chosen event). */
export interface ChosenBar {
  venueId: string
  name: string
  lng: number
  lat: number
  radiusM: number
  /** Chosen after the hiding period ended. */
  late: boolean
}

export interface HidingState {
  bar: ChosenBar | null
  /** A seeker is within the freeze radius of the bar (server-computed, hider-only). */
  frozen: boolean
  /** The hider played Move: pick a new bar (the old one stays until then). */
  moving: boolean
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The hider's view of a round: bar and freeze state. Seekers never receive these events, so
 * for them this is always empty.
 */
export function deriveHiding(events: readonly GameEvent[], round: number): HidingState {
  let state: HidingState = { bar: null, frozen: false, moving: false }
  for (const e of events) {
    if (e.payload.round !== round) continue
    if (e.type === 'bar_chosen') {
      const p = e.payload
      const lng = num(p.lng)
      const lat = num(p.lat)
      if (typeof p.venue_id !== 'string' || lng === null || lat === null) continue
      state = {
        ...state,
        bar: {
          venueId: p.venue_id,
          name: typeof p.name === 'string' ? p.name : 'Your bar',
          lng,
          lat,
          radiusM: num(p.radius_m) ?? 100,
          late: p.late === true,
        },
        // During a Move period the hiders can change their pick until it ends.
        moving: e.payload.move_open === true,
      }
    } else if (e.type === 'card_played' && isObj(e.payload.card) && isObj(e.payload.card.params) && e.payload.card.params.action === 'move') {
      state = { ...state, moving: true }
    } else if (e.type === 'move_cancelled' || e.type === 'hider_moved') {
      state = { ...state, moving: false }
    } else if (e.type === 'freeze_changed' && typeof e.payload.frozen === 'boolean') {
      state = { ...state, frozen: e.payload.frozen }
    }
  }
  return state
}

export interface HidingZoneConfig {
  barRadiusM: number
  freezeRadiusM: number
  /** How often seekers send their position. */
  locationIntervalS: number
}

/** Hiding settings from the game config, with the same defaults the server uses. */
export function hidingZone(config: Record<string, unknown>): HidingZoneConfig {
  const zone = isObj(config.hiding_zone) ? config.hiding_zone : {}
  const pos = (v: unknown, d: number) => {
    const n = num(v)
    return n !== null && n > 0 ? n : d
  }
  const barRadiusM = pos(zone.bar_radius_m, 100)
  return {
    barRadiusM,
    freezeRadiusM: pos(zone.freeze_when_seeker_within_m, barRadiusM),
    locationIntervalS: pos(config.seeker_location_interval_s, 20),
  }
}

export type RoundPhase = 'hiding' | 'seeking'

export interface RoundClock {
  phase: RoundPhase
  /** Hiding: time left. Seeking: time since the hiding period ended. Never negative. */
  ms: number
}

/**
 * The hiding period to show now: while paused by the host, it keeps ending "time left" from
 * now, so every clock freezes at the time left.
 */
export function hidingPeriodAt(
  started: { startedAt: number; hidingPeriodS: number; hidingPausedLeftMs?: number | null },
  serverNow: number,
): number {
  const left = started.hidingPausedLeftMs
  return left != null ? (serverNow + left - started.startedAt) / 1000 : started.hidingPeriodS
}

/** Where the round is on server time. Seeking time leaves out Move periods (pauses). */
export function roundClock(
  startedAt: number,
  hidingPeriodS: number,
  serverNow: number,
  pauses: readonly { from: number; to: number }[] = [],
): RoundClock {
  const endsAt = startedAt + hidingPeriodS * 1000
  return serverNow < endsAt
    ? { phase: 'hiding', ms: endsAt - serverNow }
    : { phase: 'seeking', ms: serverNow - endsAt - pausedMs(pauses, endsAt, serverNow) }
}

/**
 * A timeline time as the main clock read at that moment: "+41:00" into seeking, or "−12:30"
 * (time left to hide) during the hiding period. Counted from when seeking started, not from
 * the start of the round, so it matches the clock in the top bar.
 */
export function clockLabel(
  at: number,
  startedAt: number,
  hidingPeriodS: number,
  pauses: readonly { from: number; to: number }[] = [],
): string {
  const c = roundClock(startedAt, hidingPeriodS, at, pauses)
  return c.phase === 'hiding' ? `−${formatClock(c.ms)}` : `+${formatClock(c.ms, { up: true })}`
}

/** m:ss, or h:mm:ss from an hour. Counts down rounding up, so 0:00 only once time is up. */
export function formatClock(ms: number, { up = false } = {}): string {
  const total = Math.max(0, up ? Math.floor(ms / 1000) : Math.ceil(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/**
 * How old a seeker's position is, for their name tag: null while it's fresh (within two
 * report intervals plus slack), else "45 s" or "3 min". Phones only report while the app is
 * open, so a stale dot means that phone is locked or in someone's pocket.
 */
export function positionAge(atMs: number, serverNow: number, intervalS: number): string | null {
  const ageS = Math.max(0, (serverNow - atMs) / 1000)
  if (ageS <= 2 * intervalS + 10) return null
  return ageS < 60 ? `${Math.round(ageS)} s` : `${Math.floor(ageS / 60)} min`
}
