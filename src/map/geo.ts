import type { Feature, Polygon } from 'geojson'

/** [lng, lat] in degrees. */
export type LngLat = [number, number]

const R = 6_371_008.8 // mean Earth radius, metres
const rad = (d: number) => (d * Math.PI) / 180
const deg = (r: number) => (r * 180) / Math.PI

/** Great-circle distance in metres. */
export function distanceM(a: LngLat, b: LngLat): number {
  const dLat = rad(b[1] - a[1])
  const dLng = rad(b[0] - a[0])
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** The point at a distance (m) and bearing (degrees from north) from a start point. */
export function destination([lng, lat]: LngLat, distance: number, bearing: number): LngLat {
  const d = distance / R
  const b = rad(bearing)
  const φ1 = rad(lat)
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(d) + Math.cos(φ1) * Math.sin(d) * Math.cos(b))
  const λ2 = rad(lng) + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(φ1), Math.cos(d) - Math.sin(φ1) * Math.sin(φ2))
  return [deg(λ2), deg(φ2)]
}

/** A circle as a closed polygon ring, for drawing a radius on the map. */
export function circlePolygon(center: LngLat, radiusM: number, steps = 64): Feature<Polygon> {
  const ring: LngLat[] = []
  for (let i = 0; i < steps; i++) ring.push(destination(center, radiusM, (360 * i) / steps))
  ring.push(ring[0])
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } }
}

/** Display distance: metres under 1 km, else km (data is metres, display km). */
export function formatDistance(m: number): string {
  if (m < 1000) return `${Math.round(m / 10) * 10} m`
  return `${(m / 1000).toFixed(m < 10_000 ? 1 : 0)} km`
}
