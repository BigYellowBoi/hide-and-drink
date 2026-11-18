import { describe, expect, it } from 'vitest'
import type { Feature, Geometry } from 'geojson'
import type { PackProps } from '../map/cityPack'
import type { GameEvent } from '../sync/types'
import { barOptions } from '../hiding/bars'
import { layerLookup } from '../play/features'
import { suggestAnswer } from '../play/shading'
import type { Question } from '../play/state'
import { deriveVenues, listedVenues, packWithVenues, withVenueEdits } from './state'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>): GameEvent =>
  ({ seq: ++seq, type, payload, created_at: '2026-11-18T00:00:00Z', actor_id: null, visibility: 'all' }) as unknown as GameEvent

const venue = (id: string, name: string, lng: number): Feature<Geometry, PackProps> => ({
  type: 'Feature',
  id,
  geometry: { type: 'Point', coordinates: [lng, -27.47] },
  properties: { layer: 'venues', name, kind: 'pub' },
})
const features = [venue('a', 'Alpha', 153.03), venue('b', 'Beta', 153.01)]
const pack = {
  type: 'FeatureCollection' as const,
  pack: { city: 'brisbane', label: 'Brisbane', extent: { type: 'Point' as const, coordinates: [0, 0] } },
  features,
}
const pop = { feature_id: 'custom:1', name: 'Pop-up', kind: 'bar', lng: 153.02, lat: -27.47, round: null }
const secret = { feature_id: 'custom:2', name: 'Secret', kind: 'bar', lng: 153.0201, lat: -27.47, round: 1 }

describe('deriveVenues', () => {
  it('follows lobby adds and hides, then the start snapshot', () => {
    const lobby = deriveVenues([
      ev('venue_added', { venue: pop }),
      ev('venue_hidden', { feature_id: 'a', hidden: true }),
      ev('venue_hidden', { feature_id: 'b', hidden: true }),
      ev('venue_hidden', { feature_id: 'b', hidden: false }),
    ])
    expect(lobby.added.map((v) => v.id)).toEqual(['custom:1'])
    expect(lobby.hidden).toEqual(['a'])

    const started = deriveVenues([
      ev('venue_added', { venue: pop }),
      ev('game_started', { venues: { added: [], hidden: ['b'] } }),
    ])
    expect(started).toEqual({ added: [], hidden: ['b'] })
  })

  it('adds hider and revealed venues once', () => {
    const v = deriveVenues([ev('venue_added', { venue: secret }), ev('venues_revealed', { round: 1, venues: [secret] })])
    expect(v.added).toHaveLength(1)
    expect(v.added[0]).toMatchObject({ id: 'custom:2', round: 1 })
  })
})

describe('custom venues are treated like city-pack venues', () => {
  const edits = deriveVenues([
    ev('venue_added', { venue: pop }),
    ev('venue_added', { venue: secret }),
    ev('venue_hidden', { feature_id: 'b', hidden: true }),
  ])

  it('in the bar picker', () => {
    const opts = barOptions(packWithVenues(pack, edits), ['a', 'b', 'custom:1', 'custom:2'], [153.0201, -27.47])
    expect(opts.map((o) => o.id)).toEqual(['custom:2', 'custom:1', 'a'])
  })

  it('in the lobby list (hidden ones out)', () => {
    expect(listedVenues(withVenueEdits(features, edits), () => true).map((v) => v.name)).toEqual(['Alpha', 'Pop-up', 'Secret'])
  })

  it('in suggested answers (bonus count rule from the bar)', () => {
    const q = {
      id: 'q1',
      type: 'bonus',
      params: { count: { layer: 'venues', within_m: 50, at_least: 1 } },
    } as unknown as Question
    const zone = { bar: { point: [153.0201, -27.47] as [number, number], radiusM: 100 }, gps: null }
    // Pop-up and Secret are ~10 m apart: with them it's a yes, without them a no.
    expect(suggestAnswer(q, zone, layerLookup(withVenueEdits(features, edits)))?.answer).toBe('yes')
    expect(suggestAnswer(q, zone, layerLookup(features))?.answer).toBe('no')
  })
})
