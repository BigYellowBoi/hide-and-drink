import type { Feature, Geometry } from 'geojson'
import type { CityPack, PackProps } from '../map/cityPack'
import type { GameEvent } from '../sync/types'

/**
 * Per-game venue edits, from events: venues the host added or hid in the lobby (public,
 * snapshotted in game_started), bars the hider added this round (hider-only events, so only
 * hider phones ever have them) and hider bars revealed when a round ends. Merged into the
 * city pack's venues layer so the picker, map, shading and suggestions treat them alike.
 */

export interface CustomVenue {
  /** 'custom:<uuid>' */
  id: string
  name: string
  kind: string
  lng: number
  lat: number
  /** null: added in the lobby. Otherwise the round a hider added it in. */
  round: number | null
}

export interface VenueEdits {
  added: CustomVenue[]
  /** Venue ids (city pack or custom) the host hid. */
  hidden: string[]
}

export const noVenueEdits: VenueEdits = { added: [], hidden: [] }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function parseVenue(raw: unknown): CustomVenue | null {
  if (!isObject(raw)) return null
  const { feature_id: id, name, kind, lng, lat, round } = raw
  if (typeof id !== 'string' || typeof name !== 'string' || typeof lng !== 'number' || typeof lat !== 'number') return null
  return { id, name, kind: typeof kind === 'string' ? kind : 'bar', lng, lat, round: typeof round === 'number' ? round : null }
}

function addVenues(edits: VenueEdits, venues: CustomVenue[]): VenueEdits {
  const ids = new Set(venues.map((v) => v.id))
  return { ...edits, added: [...edits.added.filter((v) => !ids.has(v.id)), ...venues] }
}

/** Apply one event; anything else returns the same object. */
export function applyVenueEvent(edits: VenueEdits, e: GameEvent): VenueEdits {
  const p = e.payload
  switch (e.type) {
    case 'venue_added': {
      const v = parseVenue(p.venue)
      return v ? addVenues(edits, [v]) : edits
    }
    case 'venue_hidden': {
      if (typeof p.feature_id !== 'string') return edits
      const rest = edits.hidden.filter((id) => id !== p.feature_id)
      return { ...edits, hidden: p.hidden === true ? [...rest, p.feature_id] : rest }
    }
    case 'game_started': {
      // The snapshot wins over the lobby events (the server's list at start).
      if (!isObject(p.venues)) return edits
      const added = Array.isArray(p.venues.added) ? p.venues.added.map(parseVenue).filter((v): v is CustomVenue => !!v) : []
      const hidden = Array.isArray(p.venues.hidden) ? p.venues.hidden.filter((x): x is string => typeof x === 'string') : []
      // Keep hider venues already known (none yet at a first start, but harmless on replays).
      return { added: [...added, ...edits.added.filter((v) => v.round !== null && !added.some((a) => a.id === v.id))], hidden }
    }
    case 'venues_revealed': {
      const vs = Array.isArray(p.venues) ? p.venues.map(parseVenue).filter((v): v is CustomVenue => !!v) : []
      return vs.length ? addVenues(edits, vs) : edits
    }
    default:
      return edits
  }
}

export const deriveVenues = (events: readonly GameEvent[]): VenueEdits => events.reduce(applyVenueEvent, noVenueEdits)

export function venueFeature(v: CustomVenue): Feature<Geometry, PackProps> {
  return {
    type: 'Feature',
    id: v.id,
    geometry: { type: 'Point', coordinates: [v.lng, v.lat] },
    properties: { layer: 'venues', name: v.name, kind: v.kind, custom: true },
  }
}

/** The city pack's features with this game's venue edits: hidden venues out, custom ones in. */
export function withVenueEdits<T extends Feature<Geometry, PackProps>>(features: readonly T[], edits: VenueEdits): (T | Feature<Geometry, PackProps>)[] {
  if (!edits.added.length && !edits.hidden.length) return [...features]
  const hidden = new Set(edits.hidden)
  const out: (T | Feature<Geometry, PackProps>)[] = features.filter(
    (f) => f.properties.layer !== 'venues' || typeof f.id !== 'string' || !hidden.has(f.id),
  )
  for (const v of edits.added) if (!hidden.has(v.id)) out.push(venueFeature(v))
  return out
}

/** The pack with this game's venue edits applied (same pack metadata). */
export function packWithVenues(pack: CityPack, edits: VenueEdits): CityPack {
  if (!edits.added.length && !edits.hidden.length) return pack
  return { ...pack, features: withVenueEdits(pack.features, edits) }
}

export interface ListedVenue {
  id: string
  name: string
  lng: number
  lat: number
  custom: boolean
}

/** Venue points (after edits) for which inside(point) holds, by name. */
export function listedVenues(features: readonly Feature<Geometry, PackProps>[], inside: (p: [number, number]) => boolean): ListedVenue[] {
  const out: ListedVenue[] = []
  for (const f of features) {
    if (f.properties.layer !== 'venues' || typeof f.id !== 'string' || f.geometry.type !== 'Point') continue
    const [lng, lat] = f.geometry.coordinates
    if (!inside([lng, lat])) continue
    out.push({ id: f.id, name: f.properties.name, lng, lat, custom: f.properties.custom === true })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}
