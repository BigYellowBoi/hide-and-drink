import type { FeatureCollection } from 'geojson'
import type { AreaCollection } from '../map/playArea'
import {
  applyConstraints,
  areaFeature,
  cutOut,
  distancesToArea,
  distanceM,
  isLngLat,
  keepIn,
  radarCircle,
  thermometerHalf,
  thermometerSide,
  type Area,
  type Constraint,
  type LngLat,
} from './geo'
import {
  featureId,
  isCountRule,
  nearest,
  nearestRegion,
  qualifies,
  samplePoints,
  unionAll,
  type LayerLookup,
  type PackFeature,
} from './features'
import { candidatesOf, NULL_ANSWER, radarParams, thermometerParams, type Question } from './state'
import type { BBox, Point } from 'geojson'

/** City pack context for questions about features (matching, tentacles, bonus count rules). */
export interface PackContext {
  layer: LayerLookup
  /** Where nearest-feature regions are computed (play area plus a margin). */
  bounds: BBox
  barRadiusM: number
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null)

/** What one answered question says about the hider's position. */
export function constraintOf(q: Question, ctx?: PackContext): Constraint | null {
  const a = q.answer
  const p = q.params
  switch (q.type) {
    case 'matching': {
      if (!ctx || (a !== 'same' && a !== 'different') || typeof p.layer !== 'string' || typeof p.feature_id !== 'string')
        return null
      const feats = ctx.layer(p.layer)
      const mine = feats.find((f) => featureId(f) === p.feature_id)
      if (!mine?.geometry) return null
      // Areas (suburbs): the area itself. Points and lines: everywhere nearer it than any other.
      const region =
        mine.geometry.type === 'Polygon' || mine.geometry.type === 'MultiPolygon'
          ? (mine as Area)
          : nearestRegion(feats, p.feature_id, ctx.bounds)
      if (!region) return null
      return a === 'same' ? { keep: region } : { cut: region }
    }
    case 'measuring': {
      const d = num(p.distance_m)
      if ((a !== 'closer' && a !== 'further') || !isLngLat(p.target) || d === null) return null
      const c = radarCircle(p.target, Math.max(d, 1))
      return a === 'closer' ? { keep: c } : { cut: c }
    }
    case 'tentacles': {
      // The candidates are the places within radius_m of the seekers. The hider names the
      // one closest to them, but only if they are within radius_m of it; otherwise "none".
      const r = num(p.radius_m)
      if (!a || !isLngLat(p.center) || !r) return null
      const cands = candidatesOf(q)
      if (cands.length === 0) return null
      if (a === NULL_ANSWER) {
        const near = unionAll(cands.map((x) => radarCircle(x.point, r)))
        return near ? { cut: near } : null
      }
      const mine = cands.find((x) => x.feature_id === a)
      if (!mine) return null
      const c = radarCircle(mine.point, r)
      if (cands.length === 1) return { keep: c }
      const pts: PackFeature[] = cands.map((x) => ({
        type: 'Feature',
        id: x.feature_id,
        properties: {},
        geometry: { type: 'Point', coordinates: x.point },
      }))
      // Candidates are within r of the seekers and the hider within r of the candidate.
      const cell = nearestRegion(pts, a, expandBoxAround(p.center, 2 * r + 500))
      return { keep: cell ? keepIn(c, cell) : c }
    }
    case 'bonus': {
      const rule = p.count
      if (!ctx || !isCountRule(rule) || (a !== 'yes' && a !== 'no')) return null
      const venues = ctx.layer(rule.layer)
      const zones = venues
        .filter((v) => v.geometry?.type === 'Point' && qualifies(rule, v, venues) === (a === 'yes'))
        .map((v) => radarCircle((v.geometry as Point).coordinates as LngLat, ctx.barRadiusM))
      return { keep: unionAll(zones) }
    }
  }
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

const constraintCache = new Map<string, Constraint | null>()

/** Constraints are pure in (question, answer, pack): street regions are slow, so cache them. */
function cachedConstraint(q: Question, ctx?: PackContext): Constraint | null {
  if (q.type === 'radar' || q.type === 'thermometer' || q.type === 'measuring') return constraintOf(q, ctx)
  if (!ctx) return null
  const key = `${q.id}|${q.answer}|${ctx.barRadiusM}|${ctx.bounds.join(',')}`
  if (!constraintCache.has(key)) {
    let c: Constraint | null = null
    try {
      c = constraintOf(q, ctx)
    } catch {
      c = null
    }
    constraintCache.set(key, c)
  }
  return constraintCache.get(key) ?? null
}

export function shade(playArea: AreaCollection, answered: readonly Question[], ctx?: PackContext): Shading {
  const area = areaFeature(playArea)
  const constraints = answered.map((q) => cachedConstraint(q, ctx)).filter((c): c is Constraint => c !== null)
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
export function suggestAnswer(q: Question, zone: HiderZone, layer?: LayerLookup): Suggestion | null {
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

  // Bonus count rule: from the bar itself (the nearest venue to the hider), no circle.
  if (q.type === 'bonus' && isCountRule(q.params.count) && layer) {
    const rule = q.params.count
    const venues = layer(rule.layer)
    const hit = nearest(bar?.point ?? point, venues)
    return hit ? { answer: qualifies(rule, hit.feature, venues) ? 'yes' : 'no', differs: false, from } : null
  }

  // The rest: answer at the hider's point, flagged if it changes anywhere on the circle.
  const here = answerAt(q, point, layer)
  if (here === null) return null
  const differs = samplePoints(center, r).some((p) => answerAt(q, p, layer) !== here)
  return { answer: here, differs, from }
}

/** The answer the hider would give from point p, or null if the app can't tell. */
export function answerAt(q: Question, p: LngLat, layer?: LayerLookup): string | null {
  const params = q.params
  switch (q.type) {
    case 'matching': {
      if (!layer || typeof params.layer !== 'string' || typeof params.feature_id !== 'string') return null
      const hit = nearest(p, layer(params.layer))
      return hit ? (featureId(hit.feature) === params.feature_id ? 'same' : 'different') : null
    }
    case 'measuring': {
      const d = num(params.distance_m)
      return isLngLat(params.target) && d !== null ? (distanceM(p, params.target) < d ? 'closer' : 'further') : null
    }
    case 'tentacles': {
      const r = num(params.radius_m)
      if (r === null) return null
      let best: string = NULL_ANSWER
      let bestD = Infinity
      for (const c of candidatesOf(q)) {
        const d = distanceM(p, c.point)
        if (d < bestD) [best, bestD] = [c.feature_id, d]
      }
      return bestD <= r ? best : NULL_ANSWER
    }
    default:
      return null
  }
}

function expandBoxAround(c: LngLat, m: number): BBox {
  const dLat = m / 111_320
  const dLon = m / (111_320 * Math.cos((c[1] * Math.PI) / 180))
  return [c[0] - dLon, c[1] - dLat, c[0] + dLon, c[1] + dLat]
}
