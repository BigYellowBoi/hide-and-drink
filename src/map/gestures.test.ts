import { describe, expect, it } from 'vitest'
import type { Map as MapLibreMap } from 'maplibre-gl'
import { resetGestures } from './gestures'

/** A handler that records whether it was reset (disable clears its touch state). */
function handler(enabled: boolean) {
  const h = {
    enabled,
    resets: 0,
    rotation: true,
    isEnabled: () => h.enabled,
    enable: () => {
      h.enabled = true
      h.rotation = true
    },
    disable: () => {
      h.enabled = false
      h.resets++
    },
    disableRotation: () => {
      h.rotation = false
    },
  }
  return h
}

describe('resetGestures', () => {
  it('turns panning back on after a drawing tool left it off', () => {
    const map = { dragPan: handler(false), touchZoomRotate: handler(true), scrollZoom: handler(true) }
    resetGestures(map as unknown as MapLibreMap)
    expect(map.dragPan.enabled).toBe(true)
  })

  it('clears stale touch state without turning rotation back on', () => {
    const map = { dragPan: handler(true), touchZoomRotate: handler(true), scrollZoom: handler(false) }
    resetGestures(map as unknown as MapLibreMap)
    expect(map.dragPan.resets).toBe(1)
    expect(map.touchZoomRotate.resets).toBe(1)
    expect(map.touchZoomRotate.enabled).toBe(true)
    expect(map.touchZoomRotate.rotation).toBe(false)
    // Leaves a handler the map had off, off.
    expect(map.scrollZoom.enabled).toBe(false)
  })
})
