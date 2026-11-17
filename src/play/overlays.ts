import type { Feature, FeatureCollection } from 'geojson'
import { projector, radarCircle, type LngLat } from './geo'
import { candidatesOf, radarParams, thermometerParams, type Question } from './state'
import { isLngLat } from './geo'

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features })
const point = (p: LngLat): Feature => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: p } })
const line = (a: LngLat, b: LngLat): Feature => ({
  type: 'Feature',
  properties: {},
  geometry: { type: 'LineString', coordinates: [a, b] },
})

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

/** The tool of an asked question, as the seekers drew it. */
export function questionTool(q: Question): FeatureCollection {
  const r = radarParams(q)
  if (r) return radarTool(r.center, r.distance_m)
  const t = thermometerParams(q)
  if (t) return thermometerTool(t.start, t.end)
  const p = q.params
  const at = isLngLat(p.center) ? [point(p.center)] : []
  if (q.type === 'measuring' && isLngLat(p.target) && typeof p.distance_m === 'number') {
    return measuringTool(p.target, p.distance_m, isLngLat(p.center) ? p.center : null)
  }
  if (q.type === 'tentacles' && isLngLat(p.center) && typeof p.radius_m === 'number') {
    return fc([radarCircle(p.center, p.radius_m), ...at, ...candidatesOf(q).map((c) => point(c.point))])
  }
  return fc(at)
}

/** Measuring: the target and a circle through the seekers (closer = inside it). */
export function measuringTool(target: LngLat, distanceM: number, from: LngLat | null): FeatureCollection {
  return fc([radarCircle(target, Math.max(distanceM, 1)), point(target), ...(from ? [point(from)] : [])])
}
