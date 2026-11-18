import type { MultiPolygon, Polygon } from 'geojson'
import mapLayers from '../../data/map-layers.json'

/** Pack layers a seeker can tap to pick an area when shading by hand (every polygon layer). */
export const PICK_LAYERS: readonly string[] = mapLayers.layers.filter((l) => l.geometry === 'polygon').map((l) => l.id)

/** set_question_shading refuses more vertices than this (shading_too_detailed). */
export const MAX_SHADING_POINTS = 5000

export const manualAreaPoints = (g: Polygon | MultiPolygon): number =>
  g.type === 'Polygon' ? g.coordinates.reduce((n, r) => n + r.length, 0) : g.coordinates.flat().reduce((n, r) => n + r.length, 0)
