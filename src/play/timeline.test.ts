import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { derivePlay } from './state'
import { deriveCards } from '../cards/state'
import { answerPhoto, buildTimeline } from './timeline'
import { shade } from './shading'
import type { AreaCollection } from '../map/playArea'

let seq = 0
const ev = (type: string, payload: Record<string, unknown>, visibility: GameEvent['visibility'] = 'all'): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: null,
  payload,
  created_at: '2026-11-20T10:00:00Z',
})

const ask = (id: string, type = 'radar', params: Record<string, unknown> = { center: [153, -27], distance_m: 1000 }) =>
  ev('question_asked', {
    question_id: id,
    round: 1,
    type,
    option_id: '1km',
    prompt: 'Are you within ___ of me?',
    params,
    asked_by: 'u1',
    asked_at: '2026-11-20T09:40:00Z',
    deadline_at: '2026-11-20T09:45:00Z',
    deadline_s: 300,
    reward: { draw: 2, pick: 1 },
  })

const square = { type: 'Polygon', coordinates: [[[153, -27], [153.01, -27], [153.01, -26.99], [153, -26.99], [153, -27]]] }

describe('buildTimeline', () => {
  const events = [
    ev('game_started', { round: 1, started_at: '2026-11-20T09:00:00Z', hiding_period_s: 1800, deck: [] }),
    ev('seeking_started', { round: 1 }),
    ask('q1'),
    ev('question_answered', { question_id: 'q1', answer: 'yes' }),
    ev('cards_drawn', { draw_id: 'd1', question_id: 'q1', pick: 1, cards: [] }, 'hiders'),
    ev('question_shading_set', { question_id: 'q1', shading: { mode: 'cut', area: square }, by: 'u1' }),
    ask('q2', 'photos', { label: 'A tree' }),
    ev('question_answered', { question_id: 'q2', answer: 'g/q2/a.jpg' }),
  ]
  const play = derivePlay(events)
  const cards = deriveCards(events)
  const log = [...play.log, ...cards.log]

  it('puts each question on one card with what followed from it, newest first', () => {
    const items = buildTimeline(play.questions, log)
    expect(items.map((i) => (i.kind === 'question' ? i.question.id : i.entry.kind))).toEqual(['q2', 'q1', 'seeking'])
    const q1 = items[1]
    expect(q1.kind === 'question' && q1.entries.map((l) => l.kind)).toEqual(['draw', 'shading'])
  })

  it('finds the answer photo', () => {
    expect(answerPhoto(log, 'q2')).toBe('g/q2/a.jpg')
    expect(answerPhoto(log, 'q1')).toBeNull()
  })

  it('manual shading replaces the app shading', () => {
    const q1 = play.questions.find((q) => q.id === 'q1')!
    expect(q1.manualShading?.mode).toBe('cut')
    const area: AreaCollection = {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [[[152.98, -27.02], [153.03, -27.02], [153.03, -26.97], [152.98, -26.97], [152.98, -27.02]]] } }],
    }
    const s = shade(area, [q1])
    expect(s.ruledOut.features.length).toBeGreaterThan(0)
    const none = shade(area, [{ ...q1, manualShading: { mode: 'none' } }])
    expect(none.ruledOut.features).toHaveLength(0)
  })

  it('clearing manual shading goes back to the app', () => {
    const s = derivePlay([...events, ev('question_shading_set', { question_id: 'q1', shading: null })])
    expect(s.questions[0].manualShading).toBeNull()
  })
})
