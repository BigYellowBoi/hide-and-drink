import bbox from '@turf/bbox'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { featureCollection, lineString, point } from '@turf/helpers'
import pointToLineDistance from '@turf/point-to-line-distance'
import union from '@turf/union'
import voronoi from '@turf/voronoi'
import type { BBox, Feature, Geometry, Point, Position } from 'geojson'
import { destination, distanceM, type LngLat } from '../map/geo'
import type { AreaCollection } from '../map/playArea'
import type { Area } from './geo'

/**
 * Geometry against city pack features, for the questions that use them (matching,
 * tentacles, bonus count rules). Distances in metres.
 */

export type PackFeature = Feature<Geometry, { name?: string; [k: string]: unknown }>

/** Features by layer id (city pack). */
export type LayerLookup = (layer: string) => readonly PackFeature[]

export function layerLookup(features: readonly PackFeature[]): LayerLookup {
  const byLayer = new Map<string, PackFeature[]>()
  for (const f of features) {
    const layer = String(f.properties?.layer ?? '')
    let list = byLayer.get(layer)
    if (!list) byLayer.set(layer, (list = []))
    list.push(f)
  }
  return (layer) => byLayer.get(layer) ?? []
}

export const featureId = (f: PackFeature) => String(f.id ?? f.properties?.feature_id ?? '')

const M = { units: 'meters' as const }

function linesOf(g: Geometry): Position[][] {
  switch (g.type) {
    case 'LineString':
      return [g.coordinates]
    case 'MultiLineString':
    case 'Polygon':
      return g.coordinates
    case 'MultiPolygon':
      return g.coordinates.flat()
    default:
      return []
  }
}

const isArea = (g: Geometry) => g.type === 'Polygon' || g.type === 'MultiPolygon'

/** Shortest distance from a point to a feature (0 inside an area). */
export function distanceTo(p: LngLat, g: Geometry): number {
  if (g.type === 'Point') return distanceM(p, g.coordinates as LngLat)
  if (g.type === 'MultiPoint') return Math.min(...g.coordinates.map((c) => distanceM(p, c as LngLat)))
  if (isArea(g) && booleanPointInPolygon(p, g as Area['geometry'])) return 0
  let best = Infinity
  for (const line of linesOf(g)) {
    if (line.length >= 2) best = Math.min(best, pointToLineDistance(p, lineString(line), M))
  }
  return best
}

const bboxes = new WeakMap<Geometry, BBox>()
const bboxOf = (g: Geometry): BBox => {
  let b = bboxes.get(g)
  if (!b) bboxes.set(g, (b = bbox(g) as BBox))
  return b
}

/** A lower bound on the distance from p to anything inside box b (0 inside). */
export function boxDistanceM(p: LngLat, b: BBox): number {
  const dx = Math.max(b[0] - p[0], 0, p[0] - b[2])
  const dy = Math.max(b[1] - p[1], 0, p[1] - b[3])
  const lat = Math.max(Math.abs(b[1]), Math.abs(b[3]), Math.abs(p[1])) // widest latitude: fewest metres per degree
  return Math.hypot(dx * 111_000 * Math.cos((Math.min(lat, 89) * Math.PI) / 180), dy * 110_500)
}

export function nearest(p: LngLat, features: readonly PackFeature[]): { feature: PackFeature; distanceM: number } | null {
  let best: { feature: PackFeature; distanceM: number } | null = null
  for (const f of features) {
    if (!f.geometry) continue
    if (best && f.geometry.type !== 'Point' && boxDistanceM(p, bboxOf(f.geometry)) > best.distanceM) continue
    const d = distanceTo(p, f.geometry)
    if (!best || d < best.distanceM) best = { feature: f, distanceM: d }
  }
  return best
}

/** The centre plus n points on the edge of a circle (for "does the answer hold everywhere here?"). */
export function samplePoints(center: LngLat, radiusM: number, n = 12): LngLat[] {
  const out: LngLat[] = [center]
  if (radiusM > 0) for (let i = 0; i < n; i++) out.push(destination(center, radiusM, (360 * i) / n))
  return out
}

/** Bonus count rule: a venue with at least at_least others of the layer within within_m. */
export interface CountRule {
  layer: string
  within_m: number
  at_least: number
}

export function qualifies(rule: CountRule, venue: PackFeature, all: readonly PackFeature[]): boolean {
  if (venue.geometry?.type !== 'Point') return false
  const at = venue.geometry.coordinates as LngLat
  let n = 0
  for (const v of all) {
    if (v === venue || v.geometry?.type !== 'Point') continue
    if (distanceM(at, v.geometry.coordinates as LngLat) <= rule.within_m && ++n >= rule.at_least) return true
  }
  return false
}

export function isCountRule(v: unknown): v is CountRule {
  if (typeof v !== 'object' || v === null) return false
  const r = v as Record<string, unknown>
  return typeof r.layer === 'string' && typeof r.within_m === 'number' && typeof r.at_least === 'number'
}

// ------------------------------------------------------------------ nearest-feature regions

const SAMPLE_STEP_M = 40
const sampleCache = new WeakMap<Geometry, Position[]>()

/** Points standing in for a feature when splitting space by nearest feature (lines: every ~40 m). */
function samplesOf(f: PackFeature): Position[] {
  const g = f.geometry
  if (!g) return []
  if (g.type === 'Point') return [g.coordinates]
  if (g.type === 'MultiPoint') return g.coordinates
  const cached = sampleCache.get(g)
  if (cached) return cached
  const out: Position[] = []
  for (const line of linesOf(g)) {
    for (let i = 0; i < line.length; i++) {
      out.push(line[i])
      if (i === line.length - 1) break
      const [a, b] = [line[i], line[i + 1]]
      const steps = Math.floor(distanceM(a as LngLat, b as LngLat) / SAMPLE_STEP_M)
      for (let k = 1; k <= steps; k++) {
        const t = k / (steps + 1)
        out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t])
      }
    }
  }
  sampleCache.set(g, out)
  return out
}

export const expandBox = (b: BBox, m: number): BBox => {
  const dLat = m / 111_320
  const dLon = m / (111_320 * Math.cos((((b[1] + b[3]) / 2) * Math.PI) / 180))
  return [b[0] - dLon, b[1] - dLat, b[2] + dLon, b[3] + dLat]
}

/** Bounds for splitting space: the play area plus a margin. */
export const shadingBounds = (playArea: AreaCollection): BBox => expandBox(bbox(playArea) as BBox, 3000)

function unionAll(areas: Area[]): Area | null {
  if (areas.length === 0) return null
  if (areas.length === 1) return areas[0]
  return union(featureCollection(areas)) as Area | null
}

/**
 * Voronoi cells of the feature's sample points, unioned. Computed on a local metre grid
 * (nearest-by-degrees is wrong away from the equator, and small numbers keep the Voronoi
 * maths stable).
 */
function cellsWithin(features: readonly PackFeature[], id: string, bounds: BBox): Area | null {
  const [w, s, e, n] = bounds
  const lon0 = (w + e) / 2
  const lat0 = (s + n) / 2
  const ky = 111_320
  const kx = ky * Math.cos((lat0 * Math.PI) / 180)
  const fwd = (c: Position): Position => [Math.round((c[0] - lon0) * kx * 10) / 10, Math.round((c[1] - lat0) * ky * 10) / 10]
  const back = (c: Position): Position => [c[0] / kx + lon0, c[1] / ky + lat0]

  const seen = new Set<string>()
  const pts: Feature<Point, { mine: boolean }>[] = []
  for (const f of features) {
    const mine = featureId(f) === id
    for (const c of samplesOf(f)) {
      if (c[0] < w || c[0] > e || c[1] < s || c[1] > n) continue
      const xy = fwd(c)
      const key = `${xy[0]},${xy[1]}`
      if (seen.has(key)) continue
      seen.add(key)
      pts.push(point(xy, { mine }))
    }
  }
  if (!pts.some((p) => p.properties.mine)) return null
  const [x0, y0] = fwd([w, s])
  const [x1, y1] = fwd([e, n])
  const cells = voronoi(featureCollection(pts), { bbox: [x0, y0, x1, y1] })
  const own: Area[] = []
  cells.features.forEach((cell, i) => {
    if (!cell || !pts[i]?.properties.mine) return
    own.push({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: cell.geometry.coordinates.map((r) => r.map(back)) } })
  })
  return unionAll(own)
}

const LOCAL_WINDOW_M = 1500

/**
 * Everywhere closer to feature `id` than to any other feature of the list (for lines, by
 * points sampled along them), clipped to bounds. Computed first in a window around the
 * feature, which is fast for dense layers like streets; if the result reaches the window's
 * edge it may extend further, so it is recomputed over the full bounds.
 */
export function nearestRegion(features: readonly PackFeature[], id: string, bounds: BBox): Area | null {
  const mine = features.filter((f) => featureId(f) === id && f.geometry)
  if (mine.length === 0) return null
  const win = expandBox(bbox(featureCollection(mine)) as BBox, LOCAL_WINDOW_M)
  const local: BBox = [Math.max(win[0], bounds[0]), Math.max(win[1], bounds[1]), Math.min(win[2], bounds[2]), Math.min(win[3], bounds[3])]
  if (local[0] >= local[2] || local[1] >= local[3]) return null
  if (local.every((v, i) => v === bounds[i])) return cellsWithin(features, id, bounds)
  const region = cellsWithin(features, id, local)
  if (!region) return cellsWithin(features, id, bounds)
  const rb = bbox(region) as BBox
  const eps = 1e-6
  const touches =
    (rb[0] <= local[0] + eps && local[0] > bounds[0]) ||
    (rb[1] <= local[1] + eps && local[1] > bounds[1]) ||
    (rb[2] >= local[2] - eps && local[2] < bounds[2]) ||
    (rb[3] >= local[3] - eps && local[3] < bounds[3])
  return touches ? cellsWithin(features, id, bounds) : region
}

export { unionAll }
