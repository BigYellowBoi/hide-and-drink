import { describe, expect, it } from 'vitest'
import type { Polygon } from 'geojson'
import { areaKm2, asAreaCollection, cleanPolygon, collectionOf, formatKm2, outsideMask, polygonsOf } from './playArea'

const ring = [[153.02, -27.47], [153.03, -27.47], [153.03, -27.46], [153.02, -27.46], [153.02, -27.47]]
const square: Polygon = { type: 'Polygon', coordinates: [ring] }

describe('play area geometry', () => {
  it('reads stored areas in any GeoJSON shape', () => {
    expect(asAreaCollection(square)?.features).toHaveLength(1)
    expect(asAreaCollection({ type: 'Feature', geometry: square })?.features).toHaveLength(1)
    expect(asAreaCollection({ type: 'FeatureCollection', features: [{ geometry: square }, { geometry: null }] })?.features).toHaveLength(1)
    expect(asAreaCollection({ type: 'FeatureCollection', features: [] })).toBeNull()
    expect(asAreaCollection('nope')).toBeNull()
  })

  it('splits MultiPolygons for editing and rebuilds a collection', () => {
    const fc = asAreaCollection({ type: 'MultiPolygon', coordinates: [[ring], [ring]] })!
    const polys = polygonsOf(fc)
    expect(polys).toHaveLength(2)
    expect(collectionOf(polys).features).toHaveLength(2)
  })

  it('closes rings and rounds coordinates', () => {
    const open: Polygon = { type: 'Polygon', coordinates: [[[153.0200001234, -27.47], [153.03, -27.47], [153.03, -27.46]]] }
    expect(cleanPolygon(open).coordinates[0]).toEqual([[153.02, -27.47], [153.03, -27.47], [153.03, -27.46], [153.02, -27.47]])
  })

  it('measures area and masks the outside', () => {
    const fc = asAreaCollection(square)!
    expect(areaKm2(fc)).toBeCloseTo(1.1, 1)
    expect(formatKm2(areaKm2(fc))).toBe('1.1 km²')
    expect(formatKm2(19.84)).toBe('20 km²')
    const m = outsideMask(fc)
    expect(m.features[0].geometry.type).toBe('Polygon')
    expect((m.features[0].geometry as Polygon).coordinates).toHaveLength(2) // world + hole
    expect(outsideMask(null).features).toHaveLength(0)
  })
})
