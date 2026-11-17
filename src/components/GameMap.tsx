import { useEffect, useRef, useState } from 'react'
import { Map as MapLibre, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type LngLatBoundsLike, type Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { supabase } from '../lib/supabase'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { boundsOf, outsideMask, type AreaCollection } from '../map/playArea'
import { mapStyle, TAPPABLE_LAYERS } from '../map/style'

interface Props {
  city: string
  /** Outlined, with everything outside dimmed. null: show the whole pack. */
  playArea: AreaCollection | null
  /** Called once the style has loaded (e.g. to attach Terra Draw). */
  onReady?: (map: MapLibreMap) => void
  className?: string
  /** Tap a station, bar or line to see its name. */
  tapNames?: boolean
}

// MapLibre finds its worker next to its own module, which bundling breaks: point it at the
// worker file Vite emits instead.
setWorkerUrl(workerUrl)

const MODE_LABEL: Record<string, string> = { rail: 'Train', metro: 'Metro', tram: 'Tram', ferry: 'Ferry', bus: 'Bus' }

function describeFeature(layer: string, props: Record<string, unknown>): string {
  const name = typeof props.name === 'string' ? props.name : ''
  if (layer === 'stations') {
    let modes: unknown = props.modes
    if (typeof modes === 'string') modes = JSON.parse(modes) // MapLibre flattens arrays to JSON
    const list = Array.isArray(modes) ? modes.map((m) => MODE_LABEL[m] ?? m).join(', ') : ''
    return list ? `${name} · ${list}` : name
  }
  if (layer.startsWith('lines')) {
    let longNames: unknown = props.long_names
    if (typeof longNames === 'string') longNames = JSON.parse(longNames)
    const first = Array.isArray(longNames) ? longNames[0] : null
    return first ? `${name} · ${first}` : name
  }
  return name
}

/** MapLibre map of the city pack: streets, water, transit lines, stations, venues and the play area. */
export function GameMap({ city, playArea, onReady, className, tapNames = true }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const [pack, setPack] = useState<CityPack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const onReadyRef = useRef(onReady)
  useEffect(() => {
    onReadyRef.current = onReady
  }, [onReady])

  useEffect(() => {
    if (!supabase) return
    let live = true
    loadCityPack(supabase, city)
      .then((p) => live && setPack(p))
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [city])

  useEffect(() => {
    if (!pack || !container.current) return
    const extent = boundsOf({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: pack.pack.extent }] })
    const map = new MapLibre({
      container: container.current,
      style: mapStyle(pack),
      bounds: extent as LngLatBoundsLike,
      fitBoundsOptions: { padding: 16 },
      maxBounds: [extent[0] - 0.2, extent[1] - 0.2, extent[2] + 0.2, extent[3] + 0.2],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      fadeDuration: 0,
    })
    map.touchZoomRotate.disableRotation()
    map.addControl(new NavigationControl({ showCompass: false }), 'top-right')
    mapRef.current = map

    let popup: Popup | null = null
    if (tapNames) {
      map.on('click', (e) => {
        const hit = map.queryRenderedFeatures(
          [
            [e.point.x - 10, e.point.y - 10],
            [e.point.x + 10, e.point.y + 10],
          ],
          { layers: TAPPABLE_LAYERS },
        )[0]
        popup?.remove()
        if (!hit) return
        const label = document.createElement('span')
        label.textContent = describeFeature(hit.layer.id, hit.properties ?? {})
        popup = new Popup({ closeButton: false, className: 'map-popup', offset: 8 })
          .setLngLat(e.lngLat)
          .setDOMContent(label)
          .addTo(map)
      })
    }
    map.once('load', () => {
      // Start the compact attribution collapsed: it covers half a phone-sized map otherwise.
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show')
      setLoaded(true)
      onReadyRef.current?.(map)
    })
    return () => {
      popup?.remove()
      map.remove()
      mapRef.current = null
      setLoaded(false)
    }
  }, [pack, tapNames])

  // Play area: outline, dim outside, fit to it when it changes.
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    ;(map.getSource('area') as GeoJSONSource | undefined)?.setData(playArea ?? { type: 'FeatureCollection', features: [] })
    ;(map.getSource('mask') as GeoJSONSource | undefined)?.setData(outsideMask(playArea))
    if (playArea && playArea.features.length) {
      map.fitBounds(boundsOf(playArea) as LngLatBoundsLike, { padding: 24, duration: 0 })
    }
  }, [playArea, loaded])

  return (
    <div className={`game-map ${className ?? ''}`}>
      <div ref={container} className="game-map-canvas" />
      {!loaded && <p className="game-map-status muted">{error ?? (supabase ? 'Loading map…' : 'Map needs the backend.')}</p>}
    </div>
  )
}
