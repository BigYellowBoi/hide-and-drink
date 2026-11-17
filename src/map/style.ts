import type { StyleSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { layerCollection, type CityPack } from './cityPack'

/** Map colours from docs/design.md (MapLibre paint needs literal colours, not CSS variables). */
export const MAP_COLORS = {
  ground: '#1C2A37',
  streets: '#2A3B4C',
  river: '#24506E',
  bg: '#17222E',
  text: '#F0F0F0',
  muted: '#A9B4BF',
  venue: '#F2B705', // drink category colour
  areaOutline: '#F0F0F0',
  hatchFill: '#2C3E50',
  hatchLine: '#5C6B7A',
  seeker: '#FF6B6F', // --seeker-on-dark
  hider: '#5BB4F0',
} as const

/** Overlay sources every GameMap has (empty until set): see GameMap's overlays prop. */
export const OVERLAY_SOURCES = ['ruled', 'tool', 'zone', 'me'] as const
export type OverlaySource = (typeof OVERLAY_SOURCES)[number]

/** 45° hatch tile for the ruled-out area (docs/design.md): fill colour with lighter lines. */
export function hatchImage(size = 16): { width: number; height: number; data: Uint8Array } {
  const data = new Uint8Array(size * size * 4)
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const fill = hex(MAP_COLORS.hatchFill)
  const line = hex(MAP_COLORS.hatchLine)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Lines run bottom-left to top-right and wrap seamlessly across tiles.
      const on = (x + y) % size < 2
      const [r, g, b] = on ? line : fill
      data.set([r, g, b, on ? 230 : 150], (y * size + x) * 4)
    }
  }
  return { width: size, height: size, data }
}

/** Pack layers each map source draws from (ids from data/map-layers.json). */
export const PACK_SOURCES = {
  water: ['osm:water'],
  streets: ['osm:highway (named)'],
  lines: ['gtfs:lines'],
  stations: ['stations'],
  venues: ['venues'],
} as const

/** Layers that answer a tap with the feature's name. */
export const TAPPABLE_LAYERS = ['venues', 'stations', 'lines', 'lines-ferry']

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * The whole map is drawn from the city pack: no tile server, no API key, no glyphs (no text
 * labels; tapping a feature shows its name). Play area and mask sources start empty.
 */
export function mapStyle(pack: CityPack): StyleSpecification {
  const src = (layers: readonly string[]) => ({ type: 'geojson' as const, data: layerCollection(pack, [...layers]) })
  // ODbL (OpenStreetMap) asks for "© OpenStreetMap contributors"; CC BY sources by name.
  const attribution = (pack.pack.sources ?? [])
    .map((s) => (s.licence?.startsWith('ODbL') ? `© ${s.name} contributors` : s.name))
    .join(' · ')
  return {
    version: 8,
    sources: {
      water: { ...src(PACK_SOURCES.water), attribution },
      streets: src(PACK_SOURCES.streets),
      lines: src(PACK_SOURCES.lines),
      stations: src(PACK_SOURCES.stations),
      venues: src(PACK_SOURCES.venues),
      mask: { type: 'geojson', data: EMPTY },
      area: { type: 'geojson', data: EMPTY },
      ...Object.fromEntries(OVERLAY_SOURCES.map((id) => [id, { type: 'geojson' as const, data: EMPTY }])),
    },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': MAP_COLORS.ground } },
      { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': MAP_COLORS.river } },
      {
        id: 'streets',
        type: 'line',
        source: 'streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': MAP_COLORS.streets,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 2, 17, 7],
        },
      },
      {
        id: 'mask',
        type: 'fill',
        source: 'mask',
        paint: { 'fill-color': MAP_COLORS.bg, 'fill-opacity': 0.6 },
      },
      // Ruled-out area: hatch (pattern added by GameMap on load) so streets show through.
      { id: 'ruled', type: 'fill', source: 'ruled', paint: { 'fill-pattern': 'hatch' } },
      {
        id: 'lines',
        type: 'line',
        source: 'lines',
        filter: ['!=', ['get', 'mode'], 'ferry'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], MAP_COLORS.muted],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.5, 15, 3.5],
          'line-opacity': 0.85,
        },
      },
      {
        id: 'lines-ferry',
        type: 'line',
        source: 'lines',
        filter: ['==', ['get', 'mode'], 'ferry'],
        paint: {
          'line-color': ['coalesce', ['get', 'color'], MAP_COLORS.muted],
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 15, 2.5],
          'line-dasharray': [2, 2],
          'line-opacity': 0.85,
        },
      },
      {
        id: 'area-outline',
        type: 'line',
        source: 'area',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': MAP_COLORS.areaOutline, 'line-width': 2.5 },
      },
      // Hider's zone (bar circle, hiders' phones only) and the seekers' question tool.
      { id: 'zone-fill', type: 'fill', source: 'zone', paint: { 'fill-color': MAP_COLORS.hider, 'fill-opacity': 0.18 } },
      { id: 'zone-line', type: 'line', source: 'zone', paint: { 'line-color': MAP_COLORS.hider, 'line-width': 2 } },
      {
        id: 'tool-fill',
        type: 'fill',
        source: 'tool',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': MAP_COLORS.seeker, 'fill-opacity': 0.12 },
      },
      {
        id: 'tool-line',
        type: 'line',
        source: 'tool',
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': MAP_COLORS.seeker, 'line-width': 2, 'line-dasharray': [2, 1.5] },
      },
      {
        id: 'tool-points',
        type: 'circle',
        source: 'tool',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: { 'circle-color': MAP_COLORS.seeker, 'circle-radius': 5, 'circle-stroke-color': MAP_COLORS.bg, 'circle-stroke-width': 2 },
      },
      {
        id: 'venues',
        type: 'circle',
        source: 'venues',
        paint: {
          'circle-color': MAP_COLORS.venue,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 3.5, 17, 6],
          'circle-stroke-color': MAP_COLORS.bg,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 1],
        },
      },
      {
        id: 'stations',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-color': MAP_COLORS.text,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 5, 17, 8],
          'circle-stroke-color': MAP_COLORS.bg,
          'circle-stroke-width': 1.5,
        },
      },
      {
        id: 'me',
        type: 'circle',
        source: 'me',
        paint: {
          'circle-color': ['coalesce', ['get', 'color'], MAP_COLORS.hider],
          'circle-radius': 7,
          'circle-stroke-color': MAP_COLORS.text,
          'circle-stroke-width': 2,
        },
      },
    ],
  }
}
