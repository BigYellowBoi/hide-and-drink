import area from '@turf/area'
import bbox from '@turf/bbox'
import mask from '@turf/mask'
import type { Feature, FeatureCollection, MultiPolygon, Polygon, Position } from 'geojson'
import type { AreaCollection } from './mapLink'

export type { AreaCollection }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Any stored play area (FeatureCollection, Feature or bare geometry) as a polygon collection. */
export function asAreaCollection(raw: unknown): AreaCollection | null {
  if (!isObj(raw)) return null
  const items: unknown[] =
    raw.type === 'FeatureCollection' && Array.isArray(raw.features)
      ? raw.features.map((f) => (isObj(f) ? f.geometry : null))
      : raw.type === 'Feature'
        ? [raw.geometry]
        : [raw]
  const features: Feature<Polygon | MultiPolygon>[] = []
  for (const g of items) {
    if (isObj(g) && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)) {
      features.push({ type: 'Feature', properties: {}, geometry: g as unknown as Polygon | MultiPolygon })
    }
  }
  return features.length ? { type: 'FeatureCollection', features } : null
}

/** Every outer polygon on its own (MultiPolygons split), the unit Terra Draw edits. */
export function polygonsOf(fc: AreaCollection): Polygon[] {
  return fc.features.flatMap((f) =>
    f.geometry.type === 'Polygon'
      ? [f.geometry]
      : f.geometry.coordinates.map((coordinates): Polygon => ({ type: 'Polygon', coordinates })),
  )
}

const closeRing = (ring: Position[]): Position[] => {
  if (ring.length === 0) return ring
  const [a, b] = [ring[0], ring[ring.length - 1]]
  return a[0] === b[0] && a[1] === b[1] ? ring : [...ring, a]
}

/** Rounded to ~0.1 m and closed, as Terra Draw and the server expect. */
export function cleanPolygon(p: Polygon): Polygon {
  const r = (n: number) => Math.round(n * 1e6) / 1e6
  return {
    type: 'Polygon',
    coordinates: p.coordinates.map((ring) => closeRing(ring.map(([x, y]) => [r(x), r(y)]))),
  }
}

/** Polygons back into one collection, ready to save. */
export function collectionOf(polys: Polygon[]): AreaCollection {
  return {
    type: 'FeatureCollection',
    features: polys.map((p) => ({ type: 'Feature', properties: {}, geometry: cleanPolygon(p) })),
  }
}

export const areaKm2 = (fc: AreaCollection | null): number => (fc ? area(fc) / 1e6 : 0)

export const boundsOf = (fc: FeatureCollection): [number, number, number, number] =>
  bbox(fc) as [number, number, number, number]

/** The world with the play area cut out, to dim everything outside it. */
export function outsideMask(fc: AreaCollection | null): FeatureCollection {
  if (!fc || fc.features.length === 0) return { type: 'FeatureCollection', features: [] }
  const polys = polygonsOf(fc).map((p) => ({ type: 'Feature' as const, properties: {}, geometry: p }))
  return { type: 'FeatureCollection', features: [mask({ type: 'FeatureCollection', features: polys })] }
}

export const formatKm2 = (km2: number) => `${km2 < 10 ? km2.toFixed(1) : Math.round(km2)} km²`
