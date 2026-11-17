import difference from '@turf/difference'
import intersect from '@turf/intersect'
import { featureCollection } from '@turf/helpers'
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson'
import { circlePolygon, distanceM, type LngLat } from '../map/geo'
import { polygonsOf, type AreaCollection } from '../map/playArea'

export { distanceM, type LngLat }
export type Area = Feature<Polygon | MultiPolygon>

const R = 6_371_008.8
const RAD = Math.PI / 180

export const isLngLat = (v: unknown): v is LngLat =>
  Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number'

/**
 * Local flat projection in metres around an origin. Accurate to well under 1% across a
 * city, and affine in lon/lat, so straight lines stay straight both ways.
 */
export function projector(origin: LngLat) {
  const kx = R * RAD * Math.cos(origin[1] * RAD)
  const ky = R * RAD
  return {
    toXY: (p: Position): [number, number] => [(p[0] - origin[0]) * kx, (p[1] - origin[1]) * ky],
    toLngLat: ([x, y]: [number, number]): LngLat => [origin[0] + x / kx, origin[1] + y / ky],
  }
}

export const radarCircle = (center: LngLat, radiusM: number): Feature<Polygon> => circlePolygon(center, radiusM, 96)

/**
 * Everywhere closer to `toward` than to the other end of a thermometer, as a big polygon
 * (50 km each way) bounded by the perpendicular bisector of start-end.
 */
export function thermometerHalf(start: LngLat, end: LngLat, toward: 'start' | 'end'): Feature<Polygon> {
  const mid: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  const p = projector(mid)
  const [sx, sy] = p.toXY(start)
  const [ex, ey] = p.toXY(end)
  const len = Math.hypot(ex - sx, ey - sy) || 1
  const sign = toward === 'end' ? 1 : -1
  const ux = (sign * (ex - sx)) / len
  const uy = (sign * (ey - sy)) / len
  const nx = -uy
  const ny = ux
  const S = 50_000
  const ring = [
    [nx * S, ny * S],
    [nx * S + ux * S, ny * S + uy * S],
    [-nx * S + ux * S, -ny * S + uy * S],
    [-nx * S, -ny * S],
  ].map((xy) => p.toLngLat(xy as [number, number]))
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[...ring, ring[0]]] } }
}

/** Signed metres from the thermometer's bisector: positive on the end ("hotter") side. */
export function thermometerSide(start: LngLat, end: LngLat, point: LngLat): number {
  const mid: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  const p = projector(mid)
  const [sx, sy] = p.toXY(start)
  const [ex, ey] = p.toXY(end)
  const [px, py] = p.toXY(point)
  const len = Math.hypot(ex - sx, ey - sy) || 1
  return (px * (ex - sx) + py * (ey - sy)) / len
}

/** The play area as one feature (the server stores it already unioned). */
export function areaFeature(fc: AreaCollection): Area {
  const polys = polygonsOf(fc)
  return polys.length === 1
    ? { type: 'Feature', properties: {}, geometry: polys[0] }
    : { type: 'Feature', properties: {}, geometry: { type: 'MultiPolygon', coordinates: polys.map((p) => p.coordinates) } }
}

/** What an answered question says about where the hider is. */
export type Constraint = { keep: Feature<Polygon> } | { cut: Feature<Polygon> }

export const keepIn = (a: Area | null, f: Area): Area | null =>
  a ? (intersect(featureCollection([a, f])) as Area | null) : null
export const cutOut = (a: Area | null, f: Area): Area | null =>
  a ? (difference(featureCollection([a, f])) as Area | null) : null

/** Play area narrowed by every constraint. null: nothing left (answers contradict). */
export function applyConstraints(area: Area, constraints: readonly Constraint[]): Area | null {
  let out: Area | null = area
  for (const c of constraints) out = 'keep' in c ? keepIn(out, c.keep) : cutOut(out, c.cut)
  return out
}

// ------------------------------------------------------------------ point vs area, in metres

type Ring = [number, number][]

function ringsOf(a: Area): Position[][][] {
  return a.geometry.type === 'Polygon' ? [a.geometry.coordinates] : a.geometry.coordinates
}

function insideRing(x: number, y: number, ring: Ring): boolean {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]
    const [xj, yj] = ring[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function segDist(x: number, y: number, [ax, ay]: [number, number], [bx, by]: [number, number]): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy))
}

/**
 * Distance in metres from each point to an area (0 inside it). Projects once, so checking
 * a few hundred venues against a detailed area stays cheap.
 */
export function distancesToArea(area: Area | null, points: readonly LngLat[]): number[] {
  if (!area) return points.map(() => Infinity)
  const polys = ringsOf(area)
  if (!polys.length || !points.length) return points.map(() => Infinity)
  const p = projector(polys[0][0][0] as LngLat)
  const projected: Ring[][] = polys.map((rings) => rings.map((r) => r.map(p.toXY)))
  return points.map((pt) => {
    const [x, y] = p.toXY(pt)
    let best = Infinity
    for (const rings of projected) {
      if (insideRing(x, y, rings[0]) && !rings.slice(1).some((h) => insideRing(x, y, h))) return 0
      for (const r of rings) for (let i = 1; i < r.length; i++) best = Math.min(best, segDist(x, y, r[i - 1], r[i]))
    }
    return best
  })
}
