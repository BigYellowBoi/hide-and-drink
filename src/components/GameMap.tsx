import { useEffect, useRef, useState } from 'react'
import { Map as MapLibre, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type LngLatBoundsLike, type Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection } from 'geojson'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { supabase } from '../lib/supabase'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { circlePolygon } from '../map/geo'
import { boundsOf, outsideMask, type AreaCollection } from '../map/playArea'
import { MAP_COLORS, mapStyle, TAPPABLE_LAYERS } from '../map/style'

/** Game things drawn over the city: a zone circle, candidate bars and people. */
export interface MapOverlay {
  zone?: { lng: number; lat: number; radiusM: number; team: 'hiders' | 'seekers' } | null
  bars?: { id: string; name: string; lng: number; lat: number }[]
  selectedBar?: string | null
  /** me: this phone (white centre). */
  dots?: { id: string; lng: number; lat: number; team: 'hiders' | 'seekers'; me?: boolean }[]
}

const TEAM_COLOR = { hiders: MAP_COLORS.hider, seekers: MAP_COLORS.seeker } as const
const EMPTY = { type: 'FeatureCollection' as const, features: [] }

interface Props {
  city: string
  /** Outlined, with everything outside dimmed. null: show the whole pack. */
  playArea: AreaCollection | null
  /** Called once the style has loaded (e.g. to attach Terra Draw). */
  onReady?: (map: MapLibreMap) => void
  className?: string
  /** Tap a station, bar or line to see its name. */
  tapNames?: boolean
  overlay?: MapOverlay
  /** Tap one of overlay.bars. */
  onBarTap?: (id: string) => void
  /** Pan here (and zoom in to at least street level) whenever it changes. */
  focus?: { lng: number; lat: number } | null
  /** Hide the base venue dots (e.g. while overlay.bars shows the ones that matter). */
  hideVenues?: boolean
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
export function GameMap({ city, playArea, onReady, className, tapNames = true, overlay, onBarTap, focus, hideVenues = false }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  /** The play area the view was last fitted to (JSON). */
  const fittedArea = useRef<string | null>(null)
  const [pack, setPack] = useState<CityPack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const onReadyRef = useRef(onReady)
  const onBarTapRef = useRef(onBarTap)
  useEffect(() => {
    onReadyRef.current = onReady
    onBarTapRef.current = onBarTap
  }, [onReady, onBarTap])

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
        if (hit.layer.id === 'bars' && typeof hit.properties?.id === 'string') onBarTapRef.current?.(hit.properties.id)
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
      fittedArea.current = null
      setLoaded(false)
    }
  }, [pack, tapNames])

  // Play area: outline, dim outside, fit to it when its shape changes (not on every re-render
  // that rebuilds an equal object, which would undo the player's pan and zoom).
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const key = playArea ? JSON.stringify(playArea) : ''
    if (key === fittedArea.current) return
    fittedArea.current = key
    ;(map.getSource('area') as GeoJSONSource | undefined)?.setData(playArea ?? { type: 'FeatureCollection', features: [] })
    ;(map.getSource('mask') as GeoJSONSource | undefined)?.setData(outsideMask(playArea))
    if (playArea && playArea.features.length) {
      map.fitBounds(boundsOf(playArea) as LngLatBoundsLike, { padding: 24, duration: 0 })
    }
  }, [playArea, loaded])

  // Overlays: zone circle, candidate bars, people.
  const zone = overlay?.zone ?? null
  const bars = overlay?.bars
  const selectedBar = overlay?.selectedBar ?? null
  const dots = overlay?.dots
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    const set = (id: string, data: FeatureCollection) => (map.getSource(id) as GeoJSONSource | undefined)?.setData(data)
    set(
      'zone',
      zone
        ? { type: 'FeatureCollection', features: [{ ...circlePolygon([zone.lng, zone.lat], zone.radiusM), properties: { color: TEAM_COLOR[zone.team] } }] }
        : EMPTY,
    )
    set('bars', {
      type: 'FeatureCollection',
      // Selected last so it draws on top.
      features: [...(bars ?? [])]
        .sort((a, b) => Number(a.id === selectedBar) - Number(b.id === selectedBar))
        .map((b) => ({
          type: 'Feature',
          properties: { id: b.id, name: b.name, selected: b.id === selectedBar },
          geometry: { type: 'Point', coordinates: [b.lng, b.lat] },
        })),
    })
    set('dots', {
      type: 'FeatureCollection',
      features: (dots ?? []).map((d) => ({
        type: 'Feature',
        properties: { id: d.id, me: d.me === true, color: TEAM_COLOR[d.team] },
        geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
      })),
    })
  }, [zone, bars, selectedBar, dots, loaded])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.setLayoutProperty('venues', 'visibility', hideVenues ? 'none' : 'visible')
  }, [hideVenues, loaded])

  const focusLng = focus?.lng
  const focusLat = focus?.lat
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || focusLng === undefined || focusLat === undefined) return
    map.easeTo({ center: [focusLng, focusLat], zoom: Math.max(map.getZoom(), 15), duration: 400 })
  }, [focusLng, focusLat, loaded])

  return (
    <div className={`game-map ${className ?? ''}`}>
      <div ref={container} className="game-map-canvas" />
      {!loaded && <p className="game-map-status muted">{error ?? (supabase ? 'Loading map…' : 'Map needs the backend.')}</p>}
    </div>
  )
}
