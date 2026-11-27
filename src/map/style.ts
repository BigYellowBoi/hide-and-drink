import type { StyleSpecification, SymbolLayerSpecification } from 'maplibre-gl'
import type { FeatureCollection } from 'geojson'
import { layerCollection, type CityPack } from './cityPack'
import type { MapTheme } from './theme'

/** Map colours from docs/design.md (MapLibre paint needs literal colours, not CSS variables). */
type Hex = `#${string}`
type ColorKey =
  | 'ground' | 'streets' | 'river' | 'bg' | 'text' | 'muted' | 'venue'
  | 'areaOutline' | 'hider' | 'seeker' | 'hatchFill' | 'hatchLine'
export type MapColors = Record<ColorKey, Hex>

const DARK: MapColors = {
  ground: '#1C2A37',
  streets: '#2A3B4C',
  river: '#24506E',
  bg: '#17222E',
  text: '#F0F0F0',
  muted: '#A9B4BF',
  venue: '#F2B705', // drink category colour
  areaOutline: '#F0F0F0',
  hider: '#5BB4F0',
  seeker: '#FF6B6F', // --seeker-on-dark
  hatchFill: '#2C3E50',
  hatchLine: '#5C6B7A',
}

/** Light map for sunlight: pale ground, dark streets and text, deeper team colours. */
const LIGHT: MapColors = {
  ground: '#EEEAE2',
  streets: '#B3AB9D',
  river: '#8EC1E6',
  bg: '#FFFFFF',
  text: '#14202B',
  muted: '#3F4A55',
  venue: '#D99A00',
  areaOutline: '#14202B',
  hider: '#1A6FC0',
  seeker: '#D2343B',
  hatchFill: '#8A939C',
  hatchLine: '#3F4A55',
}

export const MAP_PALETTES: Record<MapTheme, MapColors> = { dark: DARK, light: LIGHT }

/** The dark palette (the default). */
export const MAP_COLORS = DARK

/** 45° hatch tile for the ruled-out area (docs/design.md): fill colour with lighter lines. */
export function hatchImage(size = 16, theme: MapTheme = 'dark'): { width: number; height: number; data: Uint8Array } {
  const c = MAP_PALETTES[theme]
  const data = new Uint8Array(size * size * 4)
  const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const fill = hex(c.hatchFill)
  const line = hex(c.hatchLine)
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
export const TAPPABLE_LAYERS = ['dots', 'bars', 'tool-points', 'venues', 'stations', 'lines', 'lines-ferry']

/** Font stack of the label glyphs in public/glyphs (built by scripts/glyphs/build.py). */
export const LABEL_FONT = 'Inter SemiBold'

/** Glyph URL template for a page served under base (Vite's BASE_URL), e.g. /hide-and-drink/. */
export const glyphsUrl = (origin: string, base: string) =>
  `${origin}${base.endsWith('/') ? base : `${base}/`}glyphs/{fontstack}/{range}.pbf`

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

/**
 * The whole map is drawn from the city pack: no tile server, no API key. Labels (street names,
 * distances on question tools) use the app's own glyphs when a glyphs URL is given; without
 * one the map has no text and tapping a feature shows its name. Play area and mask sources
 * start empty.
 */
export function mapStyle(pack: CityPack, opts: { glyphs?: string; theme?: MapTheme } = {}): StyleSpecification {
  const C = MAP_PALETTES[opts.theme ?? 'dark']
  const src = (layers: readonly string[]) => ({ type: 'geojson' as const, data: layerCollection(pack, [...layers]) })
  // ODbL (OpenStreetMap) asks for "© OpenStreetMap contributors"; CC BY sources by name.
  const attribution = (pack.pack.sources ?? [])
    .map((s) => (s.licence?.startsWith('ODbL') ? `© ${s.name} contributors` : s.name))
    .join(' · ')
  const labels: StyleSpecification['layers'] = opts.glyphs
    ? [
        {
          id: 'street-labels',
          type: 'symbol',
          source: 'streets',
          minzoom: 14.5,
          layout: {
            'symbol-placement': 'line',
            'text-field': ['get', 'name'],
            'text-font': [LABEL_FONT],
            'text-size': ['interpolate', ['linear'], ['zoom'], 14.5, 10.5, 17, 13],
            'text-max-angle': 30,
            'symbol-spacing': 280,
            'text-padding': 4,
          },
          paint: { 'text-color': C.muted, 'text-halo-color': C.ground, 'text-halo-width': 1.5 },
        },
      ]
    : []
  const labelText: SymbolLayerSpecification['layout'] = {
    'text-field': ['get', 'label'],
    'text-font': [LABEL_FONT],
    'text-size': 13,
    'text-optional': true,
  }
  // Question tools are seeker red; the hider's side of one (hiderTool, side: 'hider') is hider blue.
  const sideColour = (seeker: string = C.seeker) =>
    ['case', ['==', ['get', 'side'], 'hider'], C.hider, seeker] as unknown as string
  const labelPaint = { 'text-color': C.text, 'text-halo-color': C.bg, 'text-halo-width': 2 }
  // Distances on question tools ("0.4 km") and candidate names, from feature.properties.label.
  const toolLabels: StyleSpecification['layers'] = opts.glyphs
    ? [
        {
          id: 'tool-labels-line',
          type: 'symbol',
          source: 'tool',
          filter: ['all', ['has', 'label'], ['==', ['geometry-type'], 'LineString']],
          layout: { ...labelText, 'symbol-placement': 'line-center', 'text-offset': [0, -0.8] },
          paint: labelPaint,
        },
        {
          id: 'tool-labels-point',
          type: 'symbol',
          source: 'tool',
          filter: ['all', ['has', 'label'], ['==', ['geometry-type'], 'Point']],
          layout: { ...labelText, 'text-anchor': 'top', 'text-offset': [0, 0.9] },
          paint: labelPaint,
        },
      ]
    : []
  return {
    version: 8,
    ...(opts.glyphs ? { glyphs: opts.glyphs } : {}),
    sources: {
      water: { ...src(PACK_SOURCES.water), attribution },
      streets: src(PACK_SOURCES.streets),
      lines: src(PACK_SOURCES.lines),
      stations: src(PACK_SOURCES.stations),
      venues: src(PACK_SOURCES.venues),
      mask: { type: 'geojson', data: EMPTY },
      area: { type: 'geojson', data: EMPTY },
      zone: { type: 'geojson', data: EMPTY },
      plague: { type: 'geojson', data: EMPTY },
      bars: { type: 'geojson', data: EMPTY },
      paths: { type: 'geojson', data: EMPTY },
      dots: { type: 'geojson', data: EMPTY },
      // tolerance 0: simplification at some zooms made thin hatch pieces self-intersect,
      // and earcut then filled the hole they wrap (hatch spilling into the remaining area).
      ruled: { type: 'geojson', data: EMPTY, tolerance: 0 },
      remaining: { type: 'geojson', data: EMPTY, tolerance: 0 },
      tool: { type: 'geojson', data: EMPTY },
    },
    layers: [
      { id: 'ground', type: 'background', paint: { 'background-color': C.ground } },
      { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': C.river } },
      {
        id: 'streets',
        type: 'line',
        source: 'streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': C.streets,
          'line-width': ['interpolate', ['linear'], ['zoom'], 11, 0.6, 14, 2, 17, 7],
        },
      },
      {
        id: 'mask',
        type: 'fill',
        source: 'mask',
        paint: { 'fill-color': C.bg, 'fill-opacity': 0.6 },
      },
      // Ruled-out area: hatch (image added by GameMap on load) so streets show through.
      // No antialiasing: the hatch comes in hole-free pieces, and antialiased edges would
      // draw a faint seam where two pieces meet.
      { id: 'ruled', type: 'fill', source: 'ruled', paint: { 'fill-pattern': 'hatch', 'fill-antialias': false } },
      // Where the hider can still be: a white edge inside the hatch, so it reads at a glance.
      {
        id: 'remaining',
        type: 'line',
        source: 'remaining',
        layout: { 'line-join': 'round' },
        paint: { 'line-color': C.text, 'line-width': 2.5 },
      },
      ...labels,
      {
        id: 'lines',
        type: 'line',
        source: 'lines',
        filter: ['!=', ['get', 'mode'], 'ferry'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['coalesce', ['get', 'color'], C.muted],
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
          'line-color': ['coalesce', ['get', 'color'], C.muted],
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
        paint: { 'line-color': C.areaOutline, 'line-width': 2.5 },
      },
      // The seekers' question tool: radar circle, or thermometer path and dividing line.
      {
        id: 'tool-fill',
        type: 'fill',
        source: 'tool',
        filter: ['==', ['geometry-type'], 'Polygon'],
        paint: { 'fill-color': sideColour(), 'fill-opacity': 0.12 },
      },
      {
        id: 'tool-line',
        type: 'line',
        source: 'tool',
        filter: ['!', ['has', 'role']],
        layout: { 'line-cap': 'round' },
        paint: { 'line-color': sideColour(), 'line-width': 2, 'line-dasharray': [2, 1.5] },
      },
      {
        // The nearest feature (a street, a park edge) and the line from the seeker to the nearest candidate.
        id: 'tool-highlight',
        type: 'line',
        source: 'tool',
        filter: ['has', 'role'],
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': [
            'case',
            ['==', ['get', 'side'], 'hider'], C.hider,
            ['==', ['get', 'role'], 'nearest-line'], C.text,
            C.seeker,
          ],
          'line-width': ['case', ['==', ['get', 'role'], 'nearest-line'], 2, 4],
        },
      },
      {
        id: 'tool-points',
        type: 'circle',
        source: 'tool',
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          // Candidates: hollow, the nearest one filled white.
          'circle-color': [
            'match', ['get', 'role'], 'candidate', C.bg, 'nearest', C.text, sideColour(),
          ],
          'circle-radius': ['match', ['get', 'role'], 'nearest', 7, 5],
          'circle-stroke-color': ['match', ['get', 'role'], 'candidate', sideColour(), 'nearest', sideColour(), C.bg],
          'circle-stroke-width': 2,
        },
      },
      // Plagued World: no questions inside these circles while the curse runs (alert yellow, dashed).
      {
        id: 'plague-fill',
        type: 'fill',
        source: 'plague',
        paint: { 'fill-color': C.venue, 'fill-opacity': 0.14 },
      },
      {
        id: 'plague-line',
        type: 'line',
        source: 'plague',
        paint: { 'line-color': C.venue, 'line-width': 2.5, 'line-dasharray': [1, 1] },
      },
      {
        id: 'zone-fill',
        type: 'fill',
        source: 'zone',
        paint: { 'fill-color': ['coalesce', ['get', 'color'], C.hider], 'fill-opacity': 0.18 },
      },
      {
        id: 'zone-line',
        type: 'line',
        source: 'zone',
        paint: { 'line-color': ['coalesce', ['get', 'color'], C.hider], 'line-width': 2 },
      },
      {
        id: 'venues',
        type: 'circle',
        source: 'venues',
        paint: {
          'circle-color': C.venue,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 1.8, 14, 3.5, 17, 6],
          'circle-stroke-color': C.bg,
          'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 11, 0, 14, 1],
        },
      },
      {
        id: 'stations',
        type: 'circle',
        source: 'stations',
        paint: {
          'circle-color': C.text,
          'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 14, 5, 17, 8],
          'circle-stroke-color': C.bg,
          'circle-stroke-width': 1.5,
        },
      },
      {
        // Bars the hider may pick; the selected one in hider blue.
        id: 'bars',
        type: 'circle',
        source: 'bars',
        paint: {
          'circle-color': ['case', ['boolean', ['get', 'selected'], false], C.hider, C.venue],
          'circle-radius': [
            'interpolate', ['linear'], ['zoom'],
            11, ['case', ['boolean', ['get', 'selected'], false], 6, 3],
            15, ['case', ['boolean', ['get', 'selected'], false], 10, 6],
          ],
          'circle-stroke-color': ['case', ['boolean', ['get', 'selected'], false], C.text, C.bg],
          'circle-stroke-width': ['case', ['boolean', ['get', 'selected'], false], 2.5, 1],
        },
      },
      {
        // Replay: where each player went, in team colour.
        id: 'paths',
        type: 'line',
        source: 'paths',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': ['get', 'color'], 'line-width': 3, 'line-opacity': 0.8 },
      },
      {
        // People: you (white centre) and teammates, in team colour.
        id: 'dots',
        type: 'circle',
        source: 'dots',
        paint: {
          'circle-color': ['case', ['boolean', ['get', 'me'], false], C.text, ['get', 'color']],
          'circle-radius': ['case', ['boolean', ['get', 'me'], false], 7, 6],
          'circle-stroke-color': ['case', ['boolean', ['get', 'me'], false], ['get', 'color'], C.text],
          'circle-stroke-width': ['case', ['boolean', ['get', 'me'], false], 4, 2],
        },
      },
      ...toolLabels,
    ],
  }
}
