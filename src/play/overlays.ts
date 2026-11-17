import type { Feature, FeatureCollection } from 'geojson'
import { projector, radarCircle, type LngLat } from './geo'
import { radarParams, thermometerParams, type Question } from './state'

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
  return fc([])
}
