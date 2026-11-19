import { useEffect, useRef, useState } from 'react'
import { Map as MapLibre, Marker, NavigationControl, Popup, setWorkerUrl, type GeoJSONSource, type LngLatBoundsLike, type Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import type { FeatureCollection } from 'geojson'
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url'
import { supabase } from '../lib/supabase'
import { layerCollection, loadCityPack, type CityPack } from '../map/cityPack'
import { circlePolygon, distanceM, formatDistance } from '../map/geo'
import { boundsOf, outsideMask, type AreaCollection } from '../map/playArea'
import { resetGestures } from '../map/gestures'
import { glyphsUrl, hatchImage, MAP_COLORS, mapStyle, PACK_SOURCES, TAPPABLE_LAYERS } from '../map/style'
import { googleMapsUrl } from '../map/googleMaps'
import { packWithVenues, type VenueEdits } from '../venues/state'

/** Game things drawn over the city: a zone circle, candidate bars and people. */
export interface MapOverlay {
  zone?: { lng: number; lat: number; radiusM: number; team: 'hiders' | 'seekers' } | null
  bars?: { id: string; name: string; lng: number; lat: number }[]
  selectedBar?: string | null
  /** me: this phone (white centre). A name shows as a tag under the dot; tapping it gives the distance from me. */
  dots?: MapDot[]
  /** Area ruled out by answered questions (grey hatch). */
  ruled?: FeatureCollection
  /** Where the hider can still be (white outline), when anything is ruled out. */
  remaining?: FeatureCollection
  /** A question tool: radar circle, thermometer line (seeker red; features with side 'hider' blue). */
  tool?: FeatureCollection
}

export interface MapDot {
  id: string
  lng: number
  lat: number
  team: 'hiders' | 'seekers'
  me?: boolean
  name?: string
  /** Old position (that phone stopped reporting): the tag is dimmed. */
  stale?: boolean
}

/** "Sam · 420 m away" (straight line from this phone's dot), or just the name without one. */
function describeDot(dots: readonly MapDot[], id: unknown): string {
  const dot = dots.find((d) => d.id === id)
  if (!dot) return ''
  if (dot.me) return 'You'
  const me = dots.find((d) => d.me)
  const name = dot.name ?? (dot.team === 'seekers' ? 'Seeker' : 'Hider')
  return me ? `${name} · ${formatDistance(distanceM([me.lng, me.lat], [dot.lng, dot.lat]))} away` : name
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
  /** Called with [lng, lat] on every tap (e.g. to place a question tool by hand). */
  onTap?: (lngLat: [number, number]) => void
  /** Called with [lng, lat] on a long press (touch hold or right click), e.g. to set a playtest position. */
  onLongPress?: (lngLat: [number, number]) => void
  /** The game's venue edits: hidden venues drop off the venue dots, custom ones appear. */
  venues?: VenueEdits
}

/** Popup content: the name (or distance) and an "Open in Google Maps" link for the point. */
function popupContent(text: string, at: [number, number]): HTMLElement {
  const box = document.createElement('span')
  box.className = 'map-popup-body'
  if (text) {
    const label = document.createElement('span')
    label.textContent = text
    box.append(label)
  }
  const link = document.createElement('a')
  link.href = googleMapsUrl(at)
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = 'Open in Google Maps'
  box.append(link)
  return box
}

/** A tapped feature's own point when it has one (station, bar, dot), else where the tap landed. */
function pointOf(geometry: { type: string; coordinates?: unknown } | undefined, fallback: [number, number]): [number, number] {
  const c = geometry?.type === 'Point' ? geometry.coordinates : null
  return Array.isArray(c) && typeof c[0] === 'number' && typeof c[1] === 'number' ? [c[0], c[1]] : fallback
}

const GLYPHS = typeof location === 'undefined' ? undefined : glyphsUrl(location.origin, import.meta.env.BASE_URL)

const LONG_PRESS_MS = 500
/** A hold that drifts further than this (px) is a pan, not a press. */
const LONG_PRESS_SLOP_PX = 10

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
export function GameMap({ city, playArea, onReady, className, tapNames = true, overlay, onBarTap, focus, hideVenues = false, onTap, onLongPress, venues }: Props) {
  const container = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  /** The play area the view was last fitted to (JSON). */
  const fittedArea = useRef<string | null>(null)
  const [pack, setPack] = useState<CityPack | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const onReadyRef = useRef(onReady)
  const onBarTapRef = useRef(onBarTap)
  const onTapRef = useRef(onTap)
  const onLongPressRef = useRef(onLongPress)
  const dotsRef = useRef<readonly MapDot[]>([])
  const popupRef = useRef<Popup | null>(null)
  const tagsRef = useRef(new Map<string, Marker>())
  useEffect(() => {
    onReadyRef.current = onReady
    onBarTapRef.current = onBarTap
    onTapRef.current = onTap
    onLongPressRef.current = onLongPress
  }, [onReady, onBarTap, onTap, onLongPress])

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
      style: mapStyle(pack, { glyphs: GLYPHS }),
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

    // Long press: a timer started on a one-finger touch or mouse down, cancelled by a pan, a
    // second finger or letting go. Right click (contextmenu) counts too. The click that
    // follows a long press is swallowed so it doesn't also count as a tap.
    let pressTimer: ReturnType<typeof setTimeout> | null = null
    let pressStart: { x: number; y: number } | null = null
    let pressedAt = 0
    const cancelPress = () => {
      if (pressTimer) clearTimeout(pressTimer)
      pressTimer = null
      pressStart = null
    }
    const firePress = (lng: number, lat: number) => {
      pressedAt = Date.now()
      onLongPressRef.current?.([lng, lat])
    }
    const startPress = (point: { x: number; y: number }, lngLat: { lng: number; lat: number }) => {
      cancelPress()
      if (!onLongPressRef.current) return
      pressStart = { x: point.x, y: point.y }
      pressTimer = setTimeout(() => {
        pressTimer = null
        firePress(lngLat.lng, lngLat.lat)
      }, LONG_PRESS_MS)
    }
    const movePress = (point: { x: number; y: number }) => {
      if (pressStart && Math.hypot(point.x - pressStart.x, point.y - pressStart.y) > LONG_PRESS_SLOP_PX) cancelPress()
    }
    map.on('touchstart', (e) => (e.points.length === 1 ? startPress(e.point, e.lngLat) : cancelPress()))
    map.on('touchmove', (e) => (e.points.length === 1 ? movePress(e.point) : cancelPress()))
    map.on('touchend', cancelPress)
    map.on('touchcancel', cancelPress)
    map.on('mousedown', (e) => (e.originalEvent.button === 0 ? startPress(e.point, e.lngLat) : cancelPress()))
    map.on('mousemove', (e) => movePress(e.point))
    map.on('mouseup', cancelPress)
    map.on('dragstart', cancelPress)
    map.on('zoomstart', cancelPress)
    map.on('contextmenu', (e) => {
      // Some browsers raise contextmenu on a touch hold too: don't fire twice.
      if (!onLongPressRef.current || Date.now() - pressedAt < 1000) return
      e.preventDefault()
      cancelPress()
      firePress(e.lngLat.lng, e.lngLat.lat)
    })
    const afterPress = () => Date.now() - pressedAt < 1000

    // Touches lost while the app was hidden or the screen inert would leave the pan handler
    // stuck: reset gestures whenever either changes.
    const reset = () => {
      cancelPress()
      resetGestures(map)
    }
    const onVisibility = () => reset()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pageshow', reset)
    window.addEventListener('blur', reset)
    const inertWatch = new MutationObserver(reset)
    inertWatch.observe(document.body, { attributes: true, attributeFilter: ['inert'], subtree: true })

    map.on('click', (e) => {
      if (!afterPress()) onTapRef.current?.([e.lngLat.lng, e.lngLat.lat])
    })
    if (tapNames) {
      map.on('click', (e) => {
        if (afterPress()) return
        const hit = map.queryRenderedFeatures(
          [
            [e.point.x - 10, e.point.y - 10],
            [e.point.x + 10, e.point.y + 10],
          ],
          { layers: TAPPABLE_LAYERS },
        )[0]
        popupRef.current?.remove()
        if (!hit) return
        if (hit.layer.id === 'bars' && typeof hit.properties?.id === 'string') onBarTapRef.current?.(hit.properties.id)
        const text =
          hit.layer.id === 'dots'
            ? describeDot(dotsRef.current, hit.properties?.id)
            : describeFeature(hit.layer.id, hit.properties ?? {})
        const at = pointOf(hit.geometry, [e.lngLat.lng, e.lngLat.lat])
        popupRef.current = new Popup({ closeButton: false, className: 'map-popup', offset: 8 })
          .setLngLat(at)
          .setDOMContent(popupContent(text, at))
          .addTo(map)
      })
    }
    map.once('load', () => {
      // Hatch for the ruled-out area. Its source stays empty until after load, so this is in time.
      if (!map.hasImage('hatch')) map.addImage('hatch', hatchImage())
      // Start the compact attribution collapsed: it covers half a phone-sized map otherwise.
      map.getContainer().querySelector('.maplibregl-compact-show')?.classList.remove('maplibregl-compact-show')
      setLoaded(true)
      onReadyRef.current?.(map)
    })
    const tags = tagsRef.current
    return () => {
      cancelPress()
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pageshow', reset)
      window.removeEventListener('blur', reset)
      inertWatch.disconnect()
      popupRef.current?.remove()
      for (const m of tags.values()) m.remove()
      tags.clear()
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
  const ruled = overlay?.ruled
  const remaining = overlay?.remaining
  const tool = overlay?.tool
  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    ;(map.getSource('ruled') as GeoJSONSource | undefined)?.setData(ruled ?? EMPTY)
    ;(map.getSource('remaining') as GeoJSONSource | undefined)?.setData(remaining ?? EMPTY)
    ;(map.getSource('tool') as GeoJSONSource | undefined)?.setData(tool ?? EMPTY)
  }, [ruled, remaining, tool, loaded])

  // Name tags under other people's dots (the style has no glyphs, so these are HTML markers).
  // Tapping one shows the straight-line distance from this phone.
  useEffect(() => {
    dotsRef.current = dots ?? []
    const map = mapRef.current
    if (!map || !loaded) return
    const tags = tagsRef.current
    const named = (dots ?? []).filter((d) => !d.me && d.name)
    for (const [id, m] of tags) {
      if (!named.some((d) => d.id === id)) {
        m.remove()
        tags.delete(id)
      }
    }
    for (const d of named) {
      let m = tags.get(d.id)
      if (!m) {
        const el = document.createElement('button')
        el.type = 'button'
        el.className = `map-tag map-tag-${d.team}`
        el.addEventListener('click', (ev) => {
          ev.stopPropagation()
          const cur = dotsRef.current.find((x) => x.id === d.id)
          if (!cur) return
          popupRef.current?.remove()
          popupRef.current = new Popup({ closeButton: false, className: 'map-popup', offset: 8 })
            .setLngLat([cur.lng, cur.lat])
            .setDOMContent(popupContent(describeDot(dotsRef.current, d.id), [cur.lng, cur.lat]))
            .addTo(map)
        })
        m = new Marker({ element: el, anchor: 'top', offset: [0, 9] })
        tags.set(d.id, m.setLngLat([d.lng, d.lat]).addTo(map))
      }
      m.getElement().textContent = d.name ?? ''
      m.getElement().classList.toggle('map-tag-stale', d.stale === true)
      m.setLngLat([d.lng, d.lat])
    }
  }, [dots, loaded])

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
        properties: { id: d.id, me: d.me === true, color: TEAM_COLOR[d.team], name: d.name ?? '' },
        geometry: { type: 'Point', coordinates: [d.lng, d.lat] },
      })),
    })
  }, [zone, bars, selectedBar, dots, loaded])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded) return
    map.setLayoutProperty('venues', 'visibility', hideVenues ? 'none' : 'visible')
  }, [hideVenues, loaded])

  useEffect(() => {
    const map = mapRef.current
    if (!map || !loaded || !pack || !venues) return
    const merged = packWithVenues(pack, venues)
    ;(map.getSource('venues') as GeoJSONSource | undefined)?.setData(layerCollection(merged, [...PACK_SOURCES.venues]))
  }, [venues, pack, loaded])

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
