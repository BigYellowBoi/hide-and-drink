import type { FeatureCollection } from 'geojson'
import type { AreaCollection } from '../map/playArea'
import {
  applyConstraints,
  areaFeature,
  cutOut,
  distancesToArea,
  distanceM,
  radarCircle,
  thermometerHalf,
  thermometerSide,
  type Area,
  type Constraint,
  type LngLat,
} from './geo'
import { radarParams, thermometerParams, type Question } from './state'

/** What one answered question says about the hider's position. */
export function constraintOf(q: Question): Constraint | null {
  const r = radarParams(q)
  if (r && (q.answer === 'yes' || q.answer === 'no')) {
    const c = radarCircle(r.center, r.distance_m)
    return q.answer === 'yes' ? { keep: c } : { cut: c }
  }
  const t = thermometerParams(q)
  if (t && (q.answer === 'hotter' || q.answer === 'colder')) {
    return { keep: thermometerHalf(t.start, t.end, q.answer === 'hotter' ? 'end' : 'start') }
  }
  return null
}

export interface Shading {
  /** Where the hider can still be. null: answers contradict each other. */
  remaining: Area | null
  /** Hatched on the map: play area minus remaining. */
  ruledOut: FeatureCollection
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

export function shade(playArea: AreaCollection, answered: readonly Question[]): Shading {
  const area = areaFeature(playArea)
  const constraints = answered.map(constraintOf).filter((c): c is Constraint => c !== null)
  if (!constraints.length) return { remaining: area, ruledOut: EMPTY }
  const remaining = applyConstraints(area, constraints)
  if (!remaining) return { remaining: null, ruledOut: { type: 'FeatureCollection', features: [area] } }
  const out = cutOut(area, remaining)
  return { remaining, ruledOut: { type: 'FeatureCollection', features: out ? [out] : [] } }
}

export interface Venue {
  id: string
  name: string
  point: LngLat
}

export interface RemainingBar extends Venue {
  /** Metres from the hider zone's edge to the remaining area (0: centre is inside it). */
  inside: boolean
}

/**
 * Bars still possible: a bar stays while any part of its hiding circle overlaps the
 * remaining area (docs/spec.md §3). Only bars inside the play area count at all.
 */
export function remainingBars(
  venues: readonly Venue[],
  playArea: AreaCollection,
  remaining: Area | null,
  radiusM: number,
): RemainingBar[] {
  const inPlay = distancesToArea(areaFeature(playArea), venues.map((v) => v.point))
  const candidates = venues.filter((_, i) => inPlay[i] === 0)
  const d = distancesToArea(remaining, candidates.map((v) => v.point))
  return candidates
    .map((v, i) => ({ ...v, inside: d[i] === 0, d: d[i] }))
    .filter((v) => v.d <= radiusM)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ d: _d, ...v }) => v)
}

export interface Suggestion {
  answer: string
  /** Somewhere in the hider's circle would get the other answer. */
  differs: boolean
  /** Where the suggestion was computed from. */
  from: 'gps' | 'bar'
}

export interface HiderZone {
  /** The chosen bar's hiding circle, if a bar is locked in. */
  bar: { point: LngLat; radiusM: number } | null
  gps: { point: LngLat; accuracyM: number } | null
}

/**
 * Suggested answer from the hider's own position: GPS while it's inside the bar circle,
 * else the bar itself. Flags an answer that would differ somewhere in the circle (or, with
 * no bar yet, within GPS accuracy). Runs on the hider's phone only; never sent anywhere.
 */
export function suggestAnswer(q: Question, zone: HiderZone): Suggestion | null {
  const { bar, gps } = zone
  const gpsInBar = bar && gps ? distanceM(gps.point, bar.point) <= bar.radiusM : false
  const point = gps && (gpsInBar || !bar) ? gps.point : bar?.point
  if (!point) return null
  const from = point === bar?.point ? 'bar' : 'gps'
  // The circle the answer must hold across.
  const center = bar?.point ?? point
  const r = bar ? bar.radiusM : (gps?.accuracyM ?? 0)

  const radar = radarParams(q)
  if (radar) {
    const inside = distanceM(point, radar.center) <= radar.distance_m
    const dc = distanceM(center, radar.center)
    const allIn = dc + r <= radar.distance_m
    const allOut = dc - r > radar.distance_m
    return { answer: inside ? 'yes' : 'no', differs: !allIn && !allOut, from }
  }
  const t = thermometerParams(q)
  if (t) {
    const side = thermometerSide(t.start, t.end, point)
    const sc = thermometerSide(t.start, t.end, center)
    return { answer: side > 0 ? 'hotter' : 'colder', differs: Math.abs(sc) < r, from }
  }
  return null
}
