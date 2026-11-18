import type { Feature, FeatureCollection, Geometry, Position } from 'geojson'
import { projector, radarCircle, type LngLat } from './geo'
import { candidatesOf, radarParams, thermometerParams, type Candidate, type Question } from './state'
import { isLngLat } from './geo'
import { distanceM } from '../map/geo'
import { byDistance, closestPoint, featureId, type LayerLookup, type PackFeature } from './features'

/**
 * Question tools drawn on the map (seeker red): radar circle, thermometer line, and for
 * questions that use the city pack, the candidate points with a line to the nearest and its
 * distance. Feature properties the style reads: role (candidate, nearest, nearest-line,
 * nearest-feature) and label (text drawn next to it).
 */

type Props = { role?: string; label?: string; name?: string }
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features })
const point = (p: LngLat, props: Props = {}): Feature => ({ type: 'Feature', properties: props, geometry: { type: 'Point', coordinates: p } })
const line = (a: LngLat, b: LngLat, props: Props = {}): Feature => ({
  type: 'Feature',
  properties: props,
  geometry: { type: 'LineString', coordinates: [a, b] },
})

/** Distances on the map, always in km: "0.42 km", "3.1 km". */
export const kmLabel = (m: number) => `${(m / 1000).toFixed(m < 10_000 ? 2 : 1)} km`

/** How many candidates to draw around the seeker for a matching question (nearest first). */
const MAX_CANDIDATES = 12

export function radarTool(center: LngLat, distanceM: number): FeatureCollection {
  return fc([radarCircle(center, distanceM), point(center)])
}

/** Start and end, the path between them and the dividing line (3 km each way). */
export function thermometerTool(start: LngLat, end: LngLat | null): FeatureCollection {
  if (!end) return fc([point(start)])
  const mid: LngLat = [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2]
  const p = projector(mid)
  const [sx, sy] = p.toXY(start)
  const [ex, ey] = p.toXY(end)
  const len = Math.hypot(ex - sx, ey - sy) || 1
  const [nx, ny] = [-(ey - sy) / len, (ex - sx) / len]
  const S = 3000
  return fc([line(start, end), line(p.toLngLat([nx * S, ny * S]), p.toLngLat([-nx * S, -ny * S])), point(start), point(end)])
}

/** Measuring: the target, a circle through the seekers (closer = inside it) and the line between, in km. */
export function measuringTool(target: LngLat, distanceM: number, from: LngLat | null, name?: string): FeatureCollection {
  return fc([
    radarCircle(target, Math.max(distanceM, 1)),
    ...(from ? [line(from, target, { role: 'nearest-line', label: kmLabel(distanceM) }), point(from)] : []),
    point(target, { role: 'nearest', ...(name ? { label: name, name } : {}) }),
  ])
}

/** A feature's outline as lines (areas) or itself (lines), for highlighting. */
function outline(g: Geometry): Position[][] {
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

/**
 * Matching: the candidate features of the layer around the seeker and a line to the nearest
 * (the server's pick when given) with its distance. Points show as dots; streets, parks and
 * suburbs as a highlighted outline of the nearest one.
 */
export function nearestTool(center: LngLat, features: readonly PackFeature[], chosenId?: string | null): FeatureCollection {
  const sorted = byDistance(center, features)
  const chosen = (chosenId ? sorted.find((x) => featureId(x.feature) === chosenId) : null) ?? sorted[0]
  const out: Feature[] = [point(center)]
  if (!chosen) return fc(out)
  const g = chosen.feature.geometry
  const name = typeof chosen.feature.properties?.name === 'string' ? chosen.feature.properties.name : ''
  const at = closestPoint(center, g)
  const isPoint = g.type === 'Point' || g.type === 'MultiPoint'
  if (isPoint) {
    for (const x of sorted.slice(0, MAX_CANDIDATES)) {
      if (x === chosen || x.feature.geometry.type !== 'Point') continue
      const n = x.feature.properties?.name
      out.push(point(x.feature.geometry.coordinates as LngLat, { role: 'candidate', ...(typeof n === 'string' ? { name: n } : {}) }))
    }
  } else {
    for (const ring of outline(g)) {
      out.push({ type: 'Feature', properties: { role: 'nearest-feature' }, geometry: { type: 'LineString', coordinates: ring } })
    }
  }
  const d = distanceM(center, at)
  if (d > 1) out.push(line(center, at, { role: 'nearest-line', label: kmLabel(d) }))
  out.push(point(isPoint ? at : d > 1 ? at : center, { role: 'nearest', label: d > 1 ? name : `In ${name}`, name }))
  return fc(out)
}

/** Tentacles: the circle around the seeker, every candidate with its distance, a line to the nearest. */
export function tentaclesTool(center: LngLat, radiusM: number, candidates: readonly Candidate[]): FeatureCollection {
  const sorted = [...candidates].sort((a, b) => a.distance_m - b.distance_m)
  return fc([
    radarCircle(center, radiusM),
    point(center),
    ...(sorted[0] ? [line(center, sorted[0].point, { role: 'nearest-line' })] : []),
    ...sorted.map((c, i) =>
      point(c.point, { role: i === 0 ? 'nearest' : 'candidate', name: c.name, label: `${c.name} · ${kmLabel(c.distance_m)}` }),
    ),
  ])
}

/** Tentacles candidates before asking: every feature of the layer within the radius of the seeker. */
export function tentacleCandidates(center: LngLat, radiusM: number, features: readonly PackFeature[]): Candidate[] {
  return byDistance(center, features)
    .filter((x) => x.distanceM <= radiusM && x.feature.geometry.type === 'Point')
    .slice(0, 50)
    .map((x) => ({
      feature_id: featureId(x.feature),
      name: typeof x.feature.properties?.name === 'string' ? x.feature.properties.name : 'Unnamed',
      point: x.feature.geometry.type === 'Point' ? (x.feature.geometry.coordinates as LngLat) : center,
      distance_m: Math.round(x.distanceM),
    }))
}

/** The tool of an asked question, as the seekers drew it (layer: city pack, for matching candidates). */
export function questionTool(q: Question, layer?: LayerLookup | null): FeatureCollection {
  const r = radarParams(q)
  if (r) return radarTool(r.center, r.distance_m)
  const t = thermometerParams(q)
  if (t) return thermometerTool(t.start, t.end)
  const p = q.params
  const center = isLngLat(p.center) ? p.center : null
  if (q.type === 'measuring' && isLngLat(p.target) && typeof p.distance_m === 'number') {
    return measuringTool(p.target, p.distance_m, center, typeof p.label === 'string' ? p.label : undefined)
  }
  if (q.type === 'tentacles' && center && typeof p.radius_m === 'number') {
    return tentaclesTool(center, p.radius_m, candidatesOf(q))
  }
  if (q.type === 'matching' && center && layer && typeof p.layer === 'string') {
    return nearestTool(center, layer(p.layer), typeof p.feature_id === 'string' ? p.feature_id : null)
  }
  return fc(center ? [point(center)] : [])
}

/** Whether a question has anything to show on the map. */
export const hasTool = (q: Question) => questionTool(q).features.length > 0
