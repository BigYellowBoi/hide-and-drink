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
} as const

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
    ],
  }
}
