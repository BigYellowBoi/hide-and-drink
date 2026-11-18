import { describe, expect, it } from 'vitest'
import type { PackFeature } from './features'
import { kmLabel, nearestTool, tentacleCandidates, tentaclesTool } from './overlays'
import { textOn } from './questionTypes'

const pt = (id: string, name: string, c: [number, number]): PackFeature => ({
  type: 'Feature',
  id,
  properties: { name },
  geometry: { type: 'Point', coordinates: c },
})
const libs = [pt('a', 'Near', [153.001, -27]), pt('b', 'Far', [153.02, -27]), pt('c', 'Mid', [153.005, -27])]
const roles = (fc: { features: { properties: unknown }[] }) => fc.features.map((f) => (f.properties as { role?: string }).role)

describe('question overlays', () => {
  it('matching: candidates, the nearest and a line labelled in km', () => {
    const t = nearestTool([153, -27], libs)
    expect(roles(t).filter((r) => r === 'candidate')).toHaveLength(2)
    const near = t.features.find((f) => f.properties?.role === 'nearest')
    expect(near?.properties?.name).toBe('Near')
    expect(t.features.find((f) => f.properties?.role === 'nearest-line')?.properties?.label).toBe('0.10 km')
  })

  it("matching: the server's pick wins over the app's nearest", () => {
    const t = nearestTool([153, -27], libs, 'b')
    expect(t.features.find((f) => f.properties?.role === 'nearest')?.properties?.name).toBe('Far')
  })

  it('matching: a street is highlighted and the line goes to its closest point', () => {
    const street: PackFeature = { type: 'Feature', id: 's', properties: { name: 'Queen St' }, geometry: { type: 'LineString', coordinates: [[152.99, -26.99], [153.01, -26.99]] } }
    const t = nearestTool([153, -27], [street])
    expect(roles(t)).toContain('nearest-feature')
    const line = t.features.find((f) => f.properties?.role === 'nearest-line')
    expect(line?.properties?.label).toBe('1.11 km')
  })

  it('tentacles: every candidate within the radius, labelled with its distance', () => {
    const c = tentacleCandidates([153, -27], 1000, libs)
    expect(c.map((x) => x.name)).toEqual(['Near', 'Mid'])
    const t = tentaclesTool([153, -27], 1000, c)
    const labels = t.features.map((f) => f.properties?.label).filter(Boolean)
    expect(labels).toEqual(['Near · 0.10 km', 'Mid · 0.49 km'])
  })

  it('km labels and readable tile text', () => {
    expect(kmLabel(420)).toBe('0.42 km')
    expect(kmLabel(12_345)).toBe('12.3 km')
    expect(textOn('#F2C744')).toBe('#17222E')
    expect(textOn('#2F6FD6')).toBe('#FFFFFF')
  })
})
