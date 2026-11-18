import type { LngLat } from './geo'

/** Google Maps at a point (opens the app on phones that have it). */
export const googleMapsUrl = ([lng, lat]: LngLat): string =>
  `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lng.toFixed(6)}`
