import { describe, expect, it } from 'vitest'
import pack from '../../data/city-packs/brisbane.geojson?raw'
import layers from '../../data/map-layers.json'
import type { CityPack } from './cityPack'
import { existsSync } from 'node:fs'
import { LABEL_FONT, MAP_COLORS, PACK_SOURCES, glyphsUrl, mapStyle } from './style'

const brisbane = JSON.parse(pack) as CityPack

describe('map style', () => {
  it('draws only from layers the pipeline builds', () => {
    const ids = new Set(layers.layers.map((l) => l.id))
    for (const l of Object.values(PACK_SOURCES).flat()) expect(ids.has(l), l).toBe(true)
  })

  it('fills each source from the Brisbane pack', () => {
    const style = mapStyle(brisbane)
    const count = (s: string) => ((style.sources[s] as { data: { features: unknown[] } }).data.features.length)
    expect(count('water')).toBeGreaterThan(0)
    expect(count('streets')).toBeGreaterThan(100)
    expect(count('lines')).toBeGreaterThan(5)
    expect(count('stations')).toBeGreaterThan(20)
    expect(count('venues')).toBeGreaterThan(100)
    expect(count('area')).toBe(0)
  })

  it('draws street names and tool distances only with the app glyphs', () => {
    const glyphs = glyphsUrl('https://example.org', '/hide-and-drink/')
    expect(glyphs).toBe('https://example.org/hide-and-drink/glyphs/{fontstack}/{range}.pbf')
    const style = mapStyle(brisbane, { glyphs })
    expect(style.glyphs).toBe(glyphs)
    const symbols = style.layers.filter((l) => l.type === 'symbol')
    expect(symbols.map((l) => l.id)).toEqual(['street-labels', 'tool-labels-line', 'tool-labels-point'])
    for (const l of symbols) expect((l.layout as { 'text-font': string[] })['text-font']).toEqual([LABEL_FONT])
    expect(existsSync(`public/glyphs/${LABEL_FONT}/0-255.pbf`)).toBe(true)
  })

  it('uses the design map colours and needs no tiles', () => {
    const style = mapStyle(brisbane)
    expect(style.glyphs).toBeUndefined()
    expect(style.layers.some((l) => l.type === 'symbol')).toBe(false)
    expect(style.layers[0]).toMatchObject({ type: 'background', paint: { 'background-color': MAP_COLORS.ground } })
    expect(Object.values(style.sources).every((s) => s.type === 'geojson')).toBe(true)
    expect((style.sources.water as { attribution?: string }).attribution).toContain('© OpenStreetMap contributors')
  })
})
