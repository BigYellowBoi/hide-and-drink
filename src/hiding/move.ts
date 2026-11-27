import type { GameEvent } from '../sync/types'

/**
 * A Move period (public move_started): the hiders left `from` and have until endsAt to settle
 * at a new bar within radiusM of it. Seekers are frozen and the hide timer is paused meanwhile.
 */
export interface MovePeriod {
  seq: number
  instanceId: string
  from: { name: string; lng: number; lat: number }
  /** How far from the old bar the new one may be; null = anywhere. */
  radiusM: number | null
  startedAt: number
  /** Planned end, server ms. */
  endsAt: number
  /** When it really ended (period over, host fix), or null while it runs. */
  endedAt: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const time = (v: unknown, fallback: string) => {
  const t = Date.parse(typeof v === 'string' ? v : '')
  return Number.isNaN(t) ? Date.parse(fallback) : t
}

export function parseMoveStarted(e: GameEvent): MovePeriod | null {
  if (e.type !== 'move_started') return null
  const p = e.payload
  const from = isObj(p.from) ? p.from : null
  const lng = num(from?.lng)
  const lat = num(from?.lat)
  if (!from || lng === null || lat === null || typeof p.instance_id !== 'string') return null
  const startedAt = time(p.started_at, e.created_at)
  const ends = Date.parse(typeof p.ends_at === 'string' ? p.ends_at : '')
  return {
    seq: e.seq,
    instanceId: p.instance_id,
    from: { name: typeof from.name === 'string' ? from.name : 'their bar', lng, lat },
    radiusM: num(p.radius_m),
    startedAt,
    endsAt: Number.isNaN(ends) ? startedAt + (num(p.duration_s) ?? 600) * 1000 : ends,
    endedAt: null,
  }
}

/** When an event ends a running Move period (hider_moved, move_cancelled), else null. */
export function moveEndAt(e: GameEvent): number | null {
  if (e.type === 'hider_moved') return time(e.payload.at, e.created_at)
  if (e.type === 'move_cancelled') return Date.parse(e.created_at)
  return null
}

/** When the period stops counting: its real end, else its planned end. */
export const moveEnd = (m: MovePeriod) => Math.min(m.endsAt, m.endedAt ?? Number.POSITIVE_INFINITY)

/** The period is running at serverNow. */
export const moveRunning = (m: MovePeriod | null, serverNow: number): m is MovePeriod =>
  !!m && m.endedAt === null && serverNow < m.endsAt

/** Time paused by Move periods between from and to, ms. */
export function pausedMs(periods: readonly { from: number; to: number }[], from: number, to: number): number {
  let ms = 0
  for (const p of periods) ms += Math.max(0, Math.min(to, p.to) - Math.max(from, p.from))
  return ms
}
