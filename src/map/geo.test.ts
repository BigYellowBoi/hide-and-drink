import { describe, expect, it } from 'vitest'
import { circlePolygon, destination, distanceM, formatDistance, type LngLat } from './geo'

const CITY: LngLat = [153.0251, -27.4698]

describe('geo', () => {
  it('measures great-circle distance', () => {
    expect(distanceM(CITY, CITY)).toBe(0)
    // One degree of latitude is about 111.2 km.
    expect(distanceM([153, -27], [153, -28]) / 1000).toBeCloseTo(111.2, 0)
  })

  it('round-trips destination and distance', () => {
    for (const bearing of [0, 45, 90, 200]) {
      expect(distanceM(CITY, destination(CITY, 100, bearing))).toBeCloseTo(100, 3)
    }
  })

  it('draws a closed circle with every vertex on the radius', () => {
    const ring = circlePolygon(CITY, 100, 32).geometry.coordinates[0] as LngLat[]
    expect(ring).toHaveLength(33)
    expect(ring[0]).toEqual(ring[32])
    for (const p of ring) expect(distanceM(CITY, p)).toBeCloseTo(100, 3)
  })

  it('formats distances', () => {
    expect(formatDistance(84)).toBe('80 m')
    expect(formatDistance(1520)).toBe('1.5 km')
    expect(formatDistance(12_400)).toBe('12 km')
  })
})
