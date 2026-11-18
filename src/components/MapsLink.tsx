import { googleMapsUrl } from '../map/googleMaps'
import type { LngLat } from '../map/geo'

/** "Open in Google Maps" for a selected point: a small outlined button, or an inline link. */
export function MapsLink({ point, inline = false }: { point: LngLat; inline?: boolean }) {
  return (
    <a className={inline ? 'link' : 'link-button maps-link'} href={googleMapsUrl(point)} target="_blank" rel="noopener noreferrer">
      Open in Google Maps
    </a>
  )
}
