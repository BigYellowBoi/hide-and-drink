import type { Fix } from './useGeolocation'

/** Config key for dev/playtest mode: long-press the map to set your position instead of GPS. */
export const DEV_MODE_KEY = 'dev_mode'

/** Dev/playtest mode is on only when the config says exactly true (missing = off). */
export function isDevMode(config: Record<string, unknown>): boolean {
  return config[DEV_MODE_KEY] === true
}

/** Per game and player, so two test players on one browser don't share a point. */
export function fakePositionKey(gameId: string, userId: string | null): string {
  return `hd.fakePos.${gameId}.${userId ?? 'anon'}`
}

/** A placed point as a fix: no accuracy, marked fake so callers can say so. */
export function fakeFix(lng: number, lat: number, at: number): Fix {
  return { lng, lat, accuracyM: null, at, fake: true }
}

export function parseFakeFix(raw: string | null): Fix | null {
  if (!raw) return null
  try {
    const v: unknown = JSON.parse(raw)
    if (!v || typeof v !== 'object') return null
    const { lng, lat, at } = v as Record<string, unknown>
    if (typeof lng !== 'number' || typeof lat !== 'number' || !Number.isFinite(lng) || !Number.isFinite(lat)) return null
    if (lng < -180 || lng > 180 || lat < -90 || lat > 90) return null
    return fakeFix(lng, lat, typeof at === 'number' ? at : 0)
  } catch {
    return null
  }
}

export function serializeFakeFix(fix: Fix): string {
  return JSON.stringify({ lng: fix.lng, lat: fix.lat, at: fix.at })
}
