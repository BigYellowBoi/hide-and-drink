import area from '@turf/area'
import difference from '@turf/difference'
import { featureCollection } from '@turf/helpers'
import { describe, expect, it } from 'vitest'
import brisbaneInner from '../../data/play-areas/brisbane-inner.geojson?raw'
import type { AreaCollection } from '../map/playArea'
import { circleSteps, distanceM, distancesToArea, projector, radarCircle, thermometerHalf, thermometerSide, type Area, type LngLat } from './geo'
import { remainingBars, shade, suggestAnswer } from './shading'
import type { Question } from './state'

const O: LngLat = [153.025, -27.47]
const p = projector(O)
/** A point dx, dy metres from O. */
const at = (dx: number, dy: number) => p.toLngLat([dx, dy])

// 4 km x 4 km square centred on O.
const square: AreaCollection = {
  type: 'FeatureCollection',
  features: [
    {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [[at(-2000, -2000), at(2000, -2000), at(2000, 2000), at(-2000, 2000), at(-2000, -2000)]] },
    },
  ],
}

const q = (type: string, params: Record<string, unknown>, answer: string | null): Question => ({
  id: `${type}-${answer}`,
  seq: 1,
  round: 1,
  type,
  optionId: 'x',
  prompt: '',
  params,
  askedBy: null,
  askedAt: 0,
  deadlineAt: 0,
  deadlineS: 300,
  reward: { draw: 2, pick: 1 },
  answer,
  answeredAt: null,
  late: false,
  overdue: false,
  closedBy: null,
  randomizedFrom: null,
  rewardMultiplier: null,
})

const km2 = (f: GeoJSON.Feature | null) => (f ? area(f) / 1e6 : 0)

describe('geo', () => {
  it('measures distances in metres', () => {
    expect(distanceM(O, at(1000, 0))).toBeCloseTo(1000, -1)
    expect(distanceM(O, at(0, -500))).toBeCloseTo(500, -1)
  })

  it('distance to an area is 0 inside and edge distance outside', () => {
    const [inside, out] = distancesToArea(
      { type: 'Feature', properties: {}, geometry: square.features[0].geometry },
      [O, at(2300, 0)],
    )
    expect(inside).toBe(0)
    expect(out).toBeCloseTo(300, -1)
  })

  it('thermometer side is positive towards the end', () => {
    expect(thermometerSide(at(0, 0), at(500, 0), at(400, 100))).toBeGreaterThan(0)
    expect(thermometerSide(at(0, 0), at(500, 0), at(100, -300))).toBeLessThan(0)
    expect(thermometerSide(at(0, 0), at(500, 0), at(250, 900))).toBeCloseTo(0, 0)
  })
})

describe('shade', () => {
  it('nothing ruled out without answers', () => {
    const s = shade(square, [])
    expect(km2(s.remaining)).toBeCloseTo(16, 0)
    expect(s.ruledOut.features).toHaveLength(0)
  })

  it('radar yes keeps the circle, no cuts it out', () => {
    const yes = shade(square, [q('radar', { center: O, distance_m: 1000 }, 'yes')])
    expect(km2(yes.remaining)).toBeCloseTo(Math.PI, 1)
    expect(km2(yes.ruledOut.features[0])).toBeCloseTo(16 - Math.PI, 1)

    const no = shade(square, [q('radar', { center: O, distance_m: 1000 }, 'no')])
    expect(km2(no.remaining)).toBeCloseTo(16 - Math.PI, 1)
  })

  it('thermometer keeps the half nearer the answer', () => {
    // Walked east 500 m from the west edge's middle; bisector at x = -1750.
    const params = { start: at(-2000, 0), end: at(-1500, 0), distance_m: 500, travelled_m: 500 }
    const hot = shade(square, [q('thermometer', params, 'hotter')])
    expect(km2(hot.remaining)).toBeCloseTo(4 * 3.75, 1)
    const cold = shade(square, [q('thermometer', params, 'colder')])
    expect(km2(cold.remaining)).toBeCloseTo(4 * 0.25, 1)
  })

  it('combines answers', () => {
    const s = shade(square, [
      q('radar', { center: O, distance_m: 1000 }, 'yes'),
      q('thermometer', { start: at(-500, 0), end: at(500, 0), distance_m: 1000, travelled_m: 1000 }, 'hotter'),
    ])
    expect(km2(s.remaining)).toBeCloseTo(Math.PI / 2, 1)
  })

  it('contradicting answers leave nothing', () => {
    const s = shade(square, [
      q('radar', { center: O, distance_m: 500 }, 'yes'),
      q('radar', { center: O, distance_m: 1000 }, 'no'),
    ])
    expect(s.remaining).toBeNull()
    expect(s.ruledOut.features).toHaveLength(1)
  })
})

describe('shading geometry', () => {
  // An L-shaped play area (concave, so clipping matters) 4 km across.
  const L: AreaCollection = {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {},
        geometry: {
          type: 'Polygon',
          coordinates: [[at(-2000, -2000), at(2000, -2000), at(2000, 0), at(0, 0), at(0, 2000), at(-2000, 2000), at(-2000, -2000)]],
        },
      },
    ],
  }
  const lArea = L.features[0] as Area
  const brisbane = JSON.parse(brisbaneInner) as AreaCollection
  const bArea = brisbane.features[0] as Area
  const vertices = (f: GeoJSON.Feature): GeoJSON.Position[] => {
    const g = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon
    return (g.type === 'Polygon' ? [g.coordinates] : g.coordinates).flat(2)
  }

  it('circles keep within half a metre of the true circle at any radius', () => {
    for (const r of [50, 777, 2500, 12_345, 40_000]) {
      const ring = (radarCircle(O, r).geometry.coordinates[0] as LngLat[]).slice(0, -1)
      expect(ring.length).toBe(circleSteps(r))
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i]
        const b = ring[(i + 1) % ring.length]
        expect(distanceM(O, a)).toBeCloseTo(r, 0)
        // Chord midpoint: how far the drawn edge sags inside the circle.
        expect(r - distanceM(O, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2])).toBeLessThan(0.6)
      }
    }
  })

  it('thermometer bisector is densified', () => {
    const ring = thermometerHalf(at(-500, 0), at(500, 0), 'end').geometry.coordinates[0] as LngLat[]
    for (let i = 3; i < ring.length - 1; i++) expect(distanceM(ring[i], ring[i + 1])).toBeLessThan(101)
  })

  /** Hatch and remaining stay inside the play area, and together cover it exactly. */
  function expectInside(pa: AreaCollection, paArea: Area, qs: Question[]) {
    const s = shade(pa, qs)
    for (const f of [...s.ruledOut.features, ...(s.remaining ? [s.remaining] : [])]) {
      // Every vertex on or inside the boundary (1 cm), and nothing outside bigger than the
      // zero-width float slivers turf's own difference leaves along shared edges.
      const worst = Math.max(...distancesToArea(paArea, vertices(f) as LngLat[]))
      expect(worst).toBeLessThan(0.01)
      const spill = difference(featureCollection([f as Area, paArea]))
      expect(spill ? area(spill) : 0).toBeLessThan(1)
    }
    const total = s.ruledOut.features.reduce((t, f) => t + area(f), 0) + (s.remaining ? area(s.remaining) : 0)
    expect(total / area(paArea)).toBeCloseTo(1, 4)
  }

  it('clips to the real Brisbane area (thermometer plus a custom 2420 m radar spilled before)', () => {
    expectInside(brisbane, bArea, [
      q('thermometer', { start: [153.01796674468082, -27.474575611236418], end: [153.00434797688246, -27.448342490031745] }, 'colder'),
      { ...q('radar', { center: [153.01182913456958, -27.49031979628464], distance_m: 2420 }, 'no'), id: 'r2' },
    ])
  })

  it('never hatches outside the play area, for custom radar distances and thermometers', () => {
    let seed = 7
    const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const pt = (): LngLat => at(-3000 + 6000 * rnd(), -3000 + 6000 * rnd())
    for (let i = 0; i < 150; i++) {
      const qs = Array.from({ length: 1 + Math.floor(rnd() * 3) }, () =>
        rnd() < 0.5
          ? q('radar', { center: pt(), distance_m: Math.round(50 + rnd() * 5000) }, rnd() < 0.5 ? 'yes' : 'no')
          : q('thermometer', { start: pt(), end: pt() }, rnd() < 0.5 ? 'hotter' : 'colder'),
      ).map((x, k) => ({ ...x, id: `${i}-${k}` }))
      expectInside(L, lArea, qs)
    }
  })
})

describe('remainingBars', () => {
  const venues = [
    { id: 'a', name: 'Inside', point: at(0, 0) },
    { id: 'b', name: 'Edge', point: at(1050, 0) }, // circle reaches into a 1 km radar
    { id: 'c', name: 'Far', point: at(1500, 0) },
    { id: 'd', name: 'Outside play area', point: at(5000, 0) },
  ]

  it('keeps bars whose hiding circle overlaps the remaining area', () => {
    const s = shade(square, [q('radar', { center: O, distance_m: 1000 }, 'yes')])
    expect(remainingBars(venues, square, s.remaining, 100).map((v) => v.id)).toEqual(['b', 'a'])
  })

  it('all bars in the play area remain before any answer', () => {
    const s = shade(square, [])
    expect(remainingBars(venues, square, s.remaining, 100).map((v) => v.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('none remain when answers contradict', () => {
    expect(remainingBars(venues, square, null, 100)).toEqual([])
  })
})

describe('suggestAnswer', () => {
  const radar = q('radar', { center: O, distance_m: 1000 }, null)
  const bar = (dx: number) => ({ point: at(dx, 0), radiusM: 100 })

  it('radar from the bar, flagged when the circle straddles the edge', () => {
    expect(suggestAnswer(radar, { bar: bar(500), gps: null })).toEqual({ answer: 'yes', differs: false, from: 'bar' })
    expect(suggestAnswer(radar, { bar: bar(1500), gps: null })).toEqual({ answer: 'no', differs: false, from: 'bar' })
    expect(suggestAnswer(radar, { bar: bar(950), gps: null })).toEqual({ answer: 'yes', differs: true, from: 'bar' })
  })

  it('uses GPS while it is inside the bar circle', () => {
    const s = suggestAnswer(radar, { bar: bar(950), gps: { point: at(1040, 0), accuracyM: 10 } })
    expect(s).toEqual({ answer: 'no', differs: true, from: 'gps' })
  })

  it('ignores GPS outside the bar circle', () => {
    const s = suggestAnswer(radar, { bar: bar(500), gps: { point: at(3000, 0), accuracyM: 10 } })
    expect(s?.from).toBe('bar')
    expect(s?.answer).toBe('yes')
  })

  it('falls back to GPS with no bar, flagging within its accuracy', () => {
    expect(suggestAnswer(radar, { bar: null, gps: { point: at(990, 0), accuracyM: 30 } })).toEqual({
      answer: 'yes',
      differs: true,
      from: 'gps',
    })
    expect(suggestAnswer(radar, { bar: null, gps: null })).toBeNull()
  })

  it('thermometer', () => {
    const t = q('thermometer', { start: at(0, 0), end: at(500, 0), distance_m: 500, travelled_m: 500 }, null)
    expect(suggestAnswer(t, { bar: bar(1000), gps: null })).toEqual({ answer: 'hotter', differs: false, from: 'bar' })
    expect(suggestAnswer(t, { bar: bar(-800), gps: null })).toEqual({ answer: 'colder', differs: false, from: 'bar' })
    expect(suggestAnswer(t, { bar: bar(300), gps: null })?.differs).toBe(true)
  })
})
