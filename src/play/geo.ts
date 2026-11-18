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

/** Max gap (m) between a drawn circle's edge and the true circle, so it holds at street zoom. */
const CIRCLE_TOLERANCE_M = 0.5
/** Max spacing (m) of points along a straight shading edge (MapLibre draws straight in Mercator). */
const EDGE_STEP_M = 100

/** Vertices a circle needs so its chords stay within CIRCLE_TOLERANCE_M of the true circle. */
export function circleSteps(radiusM: number): number {
  if (!(radiusM > CIRCLE_TOLERANCE_M)) return 64
  const steps = Math.ceil(Math.PI / Math.acos(1 - CIRCLE_TOLERANCE_M / radiusM))
  return Math.min(1024, Math.max(64, steps))
}

/** A radar circle built on the sphere (geodesic points), with enough vertices for any zoom. */
export const radarCircle = (center: LngLat, radiusM: number): Feature<Polygon> =>
  circlePolygon(center, radiusM, circleSteps(radiusM))

/** a to b with extra points every EDGE_STEP_M (b itself not included). */
function densify(a: [number, number], b: [number, number]): [number, number][] {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / EDGE_STEP_M))
  return Array.from({ length: n }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
}

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
  const corners: [number, number][] = [
    [nx * S, ny * S],
    [nx * S + ux * S, ny * S + uy * S],
    [-nx * S + ux * S, -ny * S + uy * S],
    [-nx * S, -ny * S],
  ]
  // The bisector edge (last corner back to the first) is the one that crosses the play
  // area: densify it so the clipped edge stays straight on the map at any zoom.
  const ring = [...corners.slice(0, 3), ...densify(corners[3], corners[0])].map((xy) => p.toLngLat(xy))
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

/** What an answered question says about where the hider is. keep null: nowhere. */
export type Constraint = { keep: Area | null } | { cut: Area }

export const keepIn = (a: Area | null, f: Area): Area | null =>
  a ? (intersect(featureCollection([a, f])) as Area | null) : null
export const cutOut = (a: Area | null, f: Area): Area | null =>
  a ? (difference(featureCollection([a, f])) as Area | null) : null

/** f clipped to the play area, so float slivers from earlier steps never draw outside it. */
export function clipTo(area: Area, f: Area | null): Area | null {
  if (!f) return null
  try {
    return cleanArea(keepIn(area, f))
  } catch {
    return cleanArea(f)
  }
}

/** sin of the angle at which a ring may fold back on itself and still count as a spike. */
const SPIKE_SIN = 1e-6

/**
 * Removes repeated points and spikes (the ring running out along an edge and straight back)
 * from a ring. Turf's clipping leaves these where a cut line meets the play-area edge close
 * to an existing vertex; MapLibre then triangulates the overlapping edges wrongly and
 * hatches part of the remaining area. Returns null if nothing with area is left.
 */
export function cleanRing(ring: Position[]): Position[] | null {
  let pts = ring.slice(0, -1)
  let changed = true
  while (changed && pts.length >= 3) {
    changed = false
    const out: Position[] = []
    for (let i = 0; i < pts.length; i++) {
      const a = out.length ? out[out.length - 1] : pts[pts.length - 1]
      const b = pts[i]
      const c = pts[(i + 1) % pts.length]
      const [abx, aby] = [b[0] - a[0], b[1] - a[1]]
      const [bcx, bcy] = [c[0] - b[0], c[1] - b[1]]
      const ab = Math.hypot(abx, aby)
      const bc = Math.hypot(bcx, bcy)
      if (ab === 0) {
        changed = true
        continue
      }
      // Folds straight back (or near enough): b is the tip of a spike.
      if (bc > 0 && abx * bcx + aby * bcy < 0 && Math.abs(abx * bcy - aby * bcx) <= SPIKE_SIN * ab * bc) {
        changed = true
        continue
      }
      out.push(b)
    }
    pts = out
  }
  if (pts.length < 3) return null
  let twice = 0
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]
    const [x2, y2] = pts[(i + 1) % pts.length]
    twice += x1 * y2 - x2 * y1
  }
  // Under ~1 m² (in degrees² at city latitudes): a sliver, not an area.
  if (Math.abs(twice) / 2 < 1e-10) return null
  return [...pts, pts[0]]
}

/** cleanRing on every ring; drops polygons whose outer ring has nothing left. */
export function cleanArea(a: Area | null): Area | null {
  if (!a) return null
  const polys = (a.geometry.type === 'Polygon' ? [a.geometry.coordinates] : a.geometry.coordinates)
    .map((rings) => {
      const outer = cleanRing(rings[0])
      return outer ? [outer, ...rings.slice(1).map(cleanRing).filter((r): r is Position[] => r !== null)] : null
    })
    .filter((p): p is Position[][] => p !== null)
  if (!polys.length) return null
  return polys.length === 1
    ? { ...a, geometry: { type: 'Polygon', coordinates: polys[0] } }
    : { ...a, geometry: { type: 'MultiPolygon', coordinates: polys } }
}

/** Play area narrowed by every constraint. null: nothing left (answers contradict). */
export function applyConstraints(area: Area, constraints: readonly Constraint[]): Area | null {
  let out: Area | null = area
  for (const c of constraints) {
    if ('keep' in c && !c.keep) return null
    try {
      out = 'keep' in c ? keepIn(out, c.keep!) : cutOut(out, c.cut)
    } catch {
      // Degenerate geometry from one answer shouldn't break the whole map: skip it.
    }
  }
  return out
}

// ------------------------------------------------------------------ drawing

/**
 * The same area as polygons without holes, for MapLibre to fill. A polygon with a hole is
 * split in two along a north-south line through the hole, again until none is left. Holes
 * that touch their outer ring (common when answers cut a wedge that meets the play-area
 * edge) are mis-triangulated once MapLibre snaps them to tile pixels: whole triangles of the
 * remaining area got hatched. Hole-free pieces can't do that.
 */
export function holeFree(a: Area | null, depth = 0): Area[] {
  if (!a) return []
  const polys = a.geometry.type === 'Polygon' ? [a.geometry.coordinates] : a.geometry.coordinates
  const out: Area[] = []
  for (const rings of polys) {
    const poly: Area = { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: rings } }
    if (rings.length < 2 || depth >= 12) {
      out.push(poly)
      continue
    }
    const xs = rings[1].map((c) => c[0])
    const cut = (Math.min(...xs) + Math.max(...xs)) / 2
    const all = rings[0].map((c) => c[1])
    const [s, n] = [Math.min(...all) - 1, Math.max(...all) + 1]
    const ex = rings[0].map((c) => c[0])
    const [w, e] = [Math.min(...ex) - 1, Math.max(...ex) + 1]
    const box = (x0: number, x1: number): Area => ({
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[[x0, s], [x1, s], [x1, n], [x0, n], [x0, s]]] },
    })
    try {
      for (const half of [keepIn(poly, box(w, cut)), keepIn(poly, box(cut, e))]) out.push(...holeFree(cleanArea(half), depth + 1))
    } catch {
      out.push(poly)
    }
  }
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
