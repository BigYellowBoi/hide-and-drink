import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { describe, expect, it } from 'vitest'
import type { AreaCollection } from '../map/playArea'
import { distanceTo, layerLookup, shadingBounds, type PackFeature } from './features'
import type { Area, LngLat } from './geo'
import { shade, suggestAnswer, type PackContext } from './shading'
import { answerText, questionLabel, questionText, type Question } from './state'

// A 4 km square around (153.0, -27.5). Lon 0.01 deg ~ 987 m, lat 0.01 deg ~ 1113 m here.
const sq = (w: number, s: number, e: number, n: number) => [
  [w, s],
  [e, s],
  [e, n],
  [w, n],
  [w, s],
]
const playArea: AreaCollection = {
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [sq(152.98, -27.52, 153.02, -27.48)] } }],
}

const pt = (layer: string, id: string, c: LngLat): PackFeature => ({
  type: 'Feature',
  id,
  properties: { layer, name: id },
  geometry: { type: 'Point', coordinates: c },
})
const line = (layer: string, id: string, coords: LngLat[]): PackFeature => ({
  type: 'Feature',
  id,
  properties: { layer, name: id },
  geometry: { type: 'LineString', coordinates: coords },
})
const poly = (layer: string, id: string, ring: number[][]): PackFeature => ({
  type: 'Feature',
  id,
  properties: { layer, name: id },
  geometry: { type: 'Polygon', coordinates: [ring] },
})

const features: PackFeature[] = [
  pt('parks', 'west-park', [152.99, -27.5]),
  pt('parks', 'east-park', [153.01, -27.5]),
  poly('suburbs', 'Westville', sq(152.97, -27.53, 153.0, -27.47)),
  poly('suburbs', 'Eastville', sq(153.0, -27.53, 153.03, -27.47)),
  line('streets', 'North St', [
    [152.97, -27.49],
    [153.03, -27.49],
  ]),
  line('streets', 'South St', [
    [152.97, -27.51],
    [153.03, -27.51],
  ]),
  // Four bars in a cluster (each has 3 others within 50 m) and one on its own.
  pt('venues', 'bar-a', [153.0, -27.5]),
  pt('venues', 'bar-b', [153.0003, -27.5]),
  pt('venues', 'bar-c', [153.0, -27.5003]),
  pt('venues', 'bar-d', [153.0003, -27.5003]),
  pt('venues', 'lonely', [153.015, -27.485]),
]
const layer = layerLookup(features)
const ctx: PackContext = { layer, bounds: shadingBounds(playArea), barRadiusM: 100 }
const C: LngLat = [153.0, -27.5]

let n = 0
function q(type: string, params: Record<string, unknown>, answer: string | null = null): Question {
  return {
    id: `q${++n}`,
    seq: n,
    round: 1,
    type,
    optionId: 'x',
    prompt: '',
    params,
    askedBy: null,
    askedAt: 0,
    deadlineAt: 0,
    deadlineS: 300,
    reward: { draw: 1, pick: 1 },
    answer,
    answeredAt: null,
    late: false,
    overdue: false,
    closedBy: null,
    randomizedFrom: null,
    rewardMultiplier: null,
  }
}

const inside = (a: Area | null, p: LngLat) => !!a && booleanPointInPolygon(p, a)
const bar = (point: LngLat, radiusM = 100) => ({ bar: { point, radiusM }, gps: null })
const remaining = (...qs: Question[]) => shade(playArea, qs, ctx).remaining

const matchPark = (answer: string | null = null) =>
  q('matching', { label: 'Park', center: C, layer: 'parks', feature_id: 'west-park', name: 'west-park' }, answer)
const matchStreet = (answer: string | null = null) =>
  q('matching', { label: 'Street', center: C, layer: 'streets', feature_id: 'North St' }, answer)
const matchSuburb = (id: string, answer: string | null = null) =>
  q('matching', { label: 'Suburb', center: C, layer: 'suburbs', feature_id: id }, answer)
const measure = (answer: string | null = null) =>
  q('measuring', { label: 'The Target', center: C, target: [153.01, -27.5], distance_m: 987 }, answer)
const tentacles = (answer: string | null = null) =>
  q(
    'tentacles',
    {
      label: 'Parks',
      center: C,
      layer: 'parks',
      radius_m: 1500,
      null_answer: 'None within range',
      candidates: [
        { feature_id: 'west-park', name: 'West Park', point: [152.99, -27.5], distance_m: 987 },
        { feature_id: 'east-park', name: 'East Park', point: [153.01, -27.5], distance_m: 987 },
      ],
    },
    answer,
  )
const countRule = { layer: 'venues', within_m: 50, at_least: 3 }
const bars50 = (answer: string | null = null) =>
  q('bonus', { label: '3+ bars within 50 m?', answer_kind: 'yes_no', count: countRule }, answer)

describe('distanceTo', () => {
  it('measures to points, lines and areas', () => {
    expect(distanceTo([152.99, -27.5], features[0].geometry)).toBe(0)
    expect(distanceTo(C, features[4].geometry)).toBeGreaterThan(1100)
    expect(distanceTo(C, features[4].geometry)).toBeLessThan(1120)
    expect(distanceTo([152.99, -27.5], features[2].geometry)).toBe(0)
  })
})

describe('suggestAnswer (stage 2 types)', () => {
  it('matching: same nearest feature as the seekers', () => {
    expect(suggestAnswer(matchPark(), bar([152.985, -27.5]), layer)).toMatchObject({ answer: 'same', differs: false })
    expect(suggestAnswer(matchPark(), bar([153.015, -27.5]), layer)).toMatchObject({ answer: 'different', differs: false })
  })

  it('flags an answer that changes across the hiding circle', () => {
    expect(suggestAnswer(matchPark(), bar([153.0005, -27.5]), layer)?.differs).toBe(true)
  })

  it('matching on areas uses the containing area, on lines the nearest line', () => {
    expect(suggestAnswer(matchSuburb('Eastville'), bar([153.01, -27.5]), layer)?.answer).toBe('same')
    expect(suggestAnswer(matchSuburb('Eastville'), bar([152.99, -27.5]), layer)?.answer).toBe('different')
    expect(suggestAnswer(matchStreet(), bar([153.0, -27.495]), layer)?.answer).toBe('same')
    expect(suggestAnswer(matchStreet(), bar([153.0, -27.505]), layer)?.answer).toBe('different')
  })

  it('no matching suggestion without the city pack', () => {
    expect(suggestAnswer(matchPark(), bar([152.985, -27.5]))).toBeNull()
  })

  it('measuring: closer than the seekers to the target', () => {
    expect(suggestAnswer(measure(), bar([153.012, -27.5]))?.answer).toBe('closer')
    expect(suggestAnswer(measure(), bar([152.99, -27.5]))?.answer).toBe('further')
  })

  it('tentacles: nearest candidate if the hider is within the radius of it, else none', () => {
    expect(suggestAnswer(tentacles(), bar([153.008, -27.5], 0))?.answer).toBe('east-park')
    // 1.9 km from the seekers, but 0.9 km from East Park: still a valid answer.
    expect(suggestAnswer(tentacles(), bar([153.019, -27.5], 0))?.answer).toBe('east-park')
    // 2 km from East Park, the nearest candidate.
    expect(suggestAnswer(tentacles(), bar([153.03, -27.5], 0))?.answer).toBe('none')
  })

  it('bonus count rule: counts other bars near the hider\'s bar', () => {
    expect(suggestAnswer(bars50(), bar([153.0, -27.5]), layer)).toMatchObject({ answer: 'yes', differs: false })
    expect(suggestAnswer(bars50(), bar([153.015, -27.485]), layer)?.answer).toBe('no')
  })

  it('no suggestion for photos or free-text bonus questions', () => {
    expect(suggestAnswer(q('photos', { label: 'Sky' }), bar(C), layer)).toBeNull()
    expect(suggestAnswer(q('bonus', { label: 'Beer?', answer_kind: 'text' }), bar(C), layer)).toBeNull()
  })
})

describe('shade (stage 2 types)', () => {
  it('matching points: keeps or cuts the nearest-feature region', () => {
    expect(inside(remaining(matchPark('same')), [152.99, -27.51])).toBe(true)
    expect(inside(remaining(matchPark('same')), [153.01, -27.51])).toBe(false)
    expect(inside(remaining(matchPark('different')), [152.99, -27.51])).toBe(false)
    expect(inside(remaining(matchPark('different')), [153.01, -27.51])).toBe(true)
  })

  it('matching areas: keeps or cuts the area', () => {
    const r = remaining(matchSuburb('Westville', 'different'))
    expect(inside(r, [152.99, -27.5])).toBe(false)
    expect(inside(r, [153.01, -27.5])).toBe(true)
  })

  it('matching lines: nearest-street region (falls back past the local window)', () => {
    const r = remaining(matchStreet('same'))
    expect(inside(r, [153.0, -27.485])).toBe(true)
    expect(inside(r, [153.0, -27.497])).toBe(true)
    expect(inside(r, [153.0, -27.503])).toBe(false)
  })

  it('measuring: circle around the target at the seekers\' distance', () => {
    expect(inside(remaining(measure('closer')), [153.012, -27.5])).toBe(true)
    expect(inside(remaining(measure('closer')), [152.985, -27.5])).toBe(false)
    expect(inside(remaining(measure('further')), [153.012, -27.5])).toBe(false)
    expect(inside(remaining(measure('further')), [152.985, -27.5])).toBe(true)
  })

  it('tentacles none: cuts the circle around every candidate', () => {
    const r = remaining(tentacles('none'))
    expect(inside(r, C)).toBe(false)
    expect(inside(r, [153.019, -27.5])).toBe(false) // within 1.5 km of East Park
    expect(inside(r, [153.019, -27.519])).toBe(true) // 2.3 km from both
  })

  it('tentacles answer: that candidate\'s cell within the radius of it, reaching past the seekers\' circle', () => {
    const r = remaining(tentacles('east-park'))
    expect(inside(r, [153.005, -27.5])).toBe(true)
    expect(inside(r, [152.995, -27.5])).toBe(false) // closer to West Park
    expect(inside(r, [153.019, -27.5])).toBe(true) // 1.9 km from the seekers, 0.9 km from East Park
    expect(inside(r, [153.019, -27.519])).toBe(false) // 2.3 km from East Park
  })

  it('bonus count rule: keeps circles around matching bars', () => {
    const r = remaining(bars50('yes'))
    expect(inside(r, [153.0001, -27.5001])).toBe(true)
    expect(inside(r, [153.015, -27.485])).toBe(false)
  })

  it('combines answers with each other', () => {
    const r = remaining(matchSuburb('Westville', 'different'), matchStreet('same'))
    expect(inside(r, [153.01, -27.485])).toBe(true)
    expect(inside(r, [152.99, -27.485])).toBe(false)
    expect(inside(r, [153.01, -27.515])).toBe(false)
  })

  it('photos and plain bonus answers rule nothing out', () => {
    const s = shade(playArea, [q('photos', { label: 'Sky' }, 'none'), q('bonus', { answer_kind: 'text' }, 'XXXX')], ctx)
    expect(s.ruledOut.features).toHaveLength(0)
  })
})

describe('question text', () => {
  it('fills the blank with the option label', () => {
    expect(questionText({ type: 'matching', prompt: 'Is your nearest ___ the same as mine?', params: { label: 'Park' } })).toBe(
      'Is your nearest park the same as mine?',
    )
    expect(
      questionText({ type: 'measuring', prompt: 'Closer to or further from ___?', params: { label: 'The Airport' } }),
    ).toBe('Closer to or further from The Airport?')
    expect(questionText({ type: 'bonus', prompt: 'Bonus question', params: { label: 'Pokies?' } })).toBe('Pokies?')
    expect(questionText({ type: 'radar', prompt: 'Within ___?', params: { distance_m: 1000 } })).toBe('Within 1 km?')
  })

  it('labels questions and answers', () => {
    expect(questionLabel(matchPark())).toBe('Matching · Park')
    expect(questionLabel(q('radar', { distance_m: 500 }))).toBe('Radar 500 m')
    expect(answerText(matchPark(), 'same')).toBe('Same park')
    expect(answerText(tentacles(), 'east-park')).toBe('East Park')
    expect(answerText(tentacles(), 'none')).toBe('None within range')
    expect(answerText(q('photos', { label: 'Sky' }), 'g/q/x.jpg')).toBe('Photo')
    expect(answerText(bars50(), 'yes')).toBe('Yes')
    expect(answerText(q('bonus', { answer_kind: 'text' }), 'XXXX Gold')).toBe('XXXX Gold')
  })
})
