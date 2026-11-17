import { describe, expect, it } from 'vitest'
import type { CityPack } from '../map/cityPack'
import { barOptions } from './bars'

const venue = (id: string, name: string, lng: number) => ({
  type: 'Feature' as const,
  id,
  geometry: { type: 'Point' as const, coordinates: [lng, -27.47] },
  properties: { layer: 'venues', name, kind: 'pub' },
})

const pack = {
  type: 'FeatureCollection',
  pack: { city: 'brisbane', label: 'Brisbane', extent: { type: 'Point', coordinates: [0, 0] } },
  features: [
    venue('a', 'Alpha Bar', 153.03),
    venue('b', 'Beta Pub', 153.01),
    venue('c', 'Gamma Tavern', 153.02),
    venue('x', 'Not Allowed', 153.0),
    { type: 'Feature', id: 's', geometry: { type: 'Point', coordinates: [153, -27.47] }, properties: { layer: 'stations', name: 'Central' } },
  ],
} as unknown as CityPack

describe('barOptions', () => {
  it('lists only valid venues, nearest first', () => {
    const opts = barOptions(pack, ['a', 'b', 'c', 's'], [153.0, -27.47])
    expect(opts.map((o) => o.id)).toEqual(['b', 'c', 'a'])
    expect(opts[0].distanceM).toBeGreaterThan(900)
    expect(opts[0]).toMatchObject({ name: 'Beta Pub', kind: 'pub' })
  })

  it('sorts by name without a GPS fix and filters by search', () => {
    expect(barOptions(pack, ['a', 'b', 'c'], null).map((o) => o.name)).toEqual(['Alpha Bar', 'Beta Pub', 'Gamma Tavern'])
    expect(barOptions(pack, ['a', 'b', 'c'], null, ' PUB ').map((o) => o.id)).toEqual(['b'])
  })
})
