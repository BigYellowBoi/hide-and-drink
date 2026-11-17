import { describe, expect, it } from 'vitest'
import { areaFromJson, encodeHzc, importMapLink, MapLinkError } from './mapLink'

const square = {
  type: 'Polygon',
  coordinates: [[[153.02, -27.47], [153.03, -27.47], [153.03, -27.46], [153.02, -27.46], [153.02, -27.47]]],
}
// What the generator writes for a drawn area: polyGeoJSON plus questions and settings.
const generatorState = {
  type: 'FeatureCollection',
  features: [
    { type: 'Feature', properties: {}, geometry: square },
    { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [153.02, -27.47] } },
  ],
  questions: [{ id: 'radius', key: 1, data: {} }],
  hidingRadius: 0.5,
  hidingRadiusUnits: 'miles',
  disabledStations: [],
}
const noFetch = () => Promise.reject(new Error('no network in tests'))

describe('importMapLink', () => {
  it('decodes a current (hzc) share link', async () => {
    const hzc = await encodeHzc(JSON.stringify(generatorState))
    const r = await importMapLink(`https://taibeled.github.io/JetLagHideAndSeek/?hzc=${hzc}`, noFetch)
    expect(r.area.features).toHaveLength(1)
    expect(r.area.features[0].geometry).toEqual(square)
    expect(r.source).toBe('Hide and Seek Map Generator (link)')
    expect(r.notes).toEqual([
      '1 non-area shapes skipped.',
      '1 question in the link ignored.',
      'Hiding radius (0.5 miles) ignored: set it in game settings.',
    ])
  })

  it('decodes legacy (hz) links and links without a scheme', async () => {
    const hz = btoa(JSON.stringify({ type: 'FeatureCollection', features: [{ type: 'Feature', properties: {}, geometry: square }] }))
    const r = await importMapLink(`taibeled.github.io/JetLagHideAndSeek/?hz=${encodeURIComponent(hz)}`, noFetch)
    expect(r.area.features[0].geometry).toEqual(square)
    expect(r.notes).toEqual([])
  })

  it('accepts pasted JSON', async () => {
    const r = await importMapLink(JSON.stringify(square), noFetch)
    expect(r.source).toBe('Hide and Seek Map Generator (pasted JSON)')
  })

  it('downloads Pastebin links and explains when it cannot', async () => {
    const ok = await importMapLink('https://x/?pb=abc123', async (url) => {
      expect(url).toBe('https://pastebin.com/raw/abc123')
      return { ok: true, status: 200, text: async () => JSON.stringify(generatorState) }
    })
    expect(ok.area.features).toHaveLength(1)
    await expect(importMapLink('https://x/?pb=abc123', noFetch)).rejects.toThrow(/without Pastebin/)
  })

  it('refuses links with no area, damaged data or no map', async () => {
    await expect(importMapLink('', noFetch)).rejects.toBeInstanceOf(MapLinkError)
    await expect(importMapLink('https://example.com/?hzc=AAAA', noFetch)).rejects.toThrow(/damaged/)
    await expect(importMapLink('https://example.com/?foo=1', noFetch)).rejects.toThrow(/no map/)
    await expect(importMapLink('hello there', noFetch)).rejects.toThrow(/Map Generator link/)
    await expect(importMapLink('https://x/?url=http://insecure', noFetch)).rejects.toThrow(/https/)
  })
})

describe('areaFromJson', () => {
  it('explains named-place (OSM boundary) links instead of importing nothing', () => {
    const place = { type: 'Feature', properties: { isHidingZone: true, name: 'Brisbane', osm_id: 1 }, geometry: { type: 'Point', coordinates: [0, 0] } }
    expect(() => areaFromJson(place)).toThrow(/boundary of Brisbane/)
  })

  it('keeps MultiPolygons and drops everything else', () => {
    const multi = { type: 'MultiPolygon', coordinates: [square.coordinates] }
    const r = areaFromJson({ type: 'Feature', properties: { name: ' Inner ' }, geometry: multi })
    expect(r.area.features[0].geometry).toEqual(multi)
    expect(r.name).toBe('Inner')
    expect(() => areaFromJson({ type: 'FeatureCollection', features: [] })).toThrow(/no drawn area/)
  })
})
