import type { Map as MapLibreMap } from 'maplibre-gl'

/**
 * Puts the map's gesture handlers back to a clean, panning state: re-enables drag pan (a
 * drawing tool can leave it disabled) and clears touch state that a lost touchend left
 * behind (the screen going inert or the app being backgrounded mid-gesture). Without this
 * the map can stop panning until a reload.
 */
export function resetGestures(map: MapLibreMap) {
  if (map.dragPan.isEnabled()) map.dragPan.disable()
  map.dragPan.enable()
  if (map.touchZoomRotate.isEnabled()) {
    map.touchZoomRotate.disable()
    map.touchZoomRotate.enable()
    map.touchZoomRotate.disableRotation()
  }
  if (map.scrollZoom.isEnabled()) {
    map.scrollZoom.disable()
    map.scrollZoom.enable()
  }
}
