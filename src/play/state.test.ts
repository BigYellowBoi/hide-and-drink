import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { derivePlay, dueTimer, outcomeText, questionLabel, shadable } from './state'

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

const T0 = Date.parse('2026-11-20T09:00:00Z')

const started = ev('game_started', { round: 1, started_at: '2026-11-20T09:00:00Z', hiding_period_s: 1800 })
const asked = ev('question_asked', {
  question_id: 'q1',
  round: 1,
  type: 'radar',
  option_id: '1km',
  prompt: 'Are you within ___ of me?',
  params: { center: [153, -27], distance_m: 1000 },
  asked_by: 'u1',
  asked_at: '2026-11-20T09:40:00Z',
  deadline_at: '2026-11-20T09:45:00Z',
  deadline_s: 300,
  reward: { draw: 2, pick: 1 },
})

describe('derivePlay', () => {
  it('tracks the hiding period end', () => {
    const s = derivePlay([started])
    expect(s.seekingAt).toBe(T0 + 1800_000)
    expect(s.seekingStarted).toBe(false)
    expect(s.pending).toBeNull()
  })

  it('a question is pending until answered', () => {
    const s = derivePlay([started, ev('seeking_started', { round: 1 }), asked])
    expect(s.pending?.id).toBe('q1')
    expect(s.pending?.deadlineAt).toBe(Date.parse('2026-11-20T09:45:00Z'))
    expect(questionLabel(s.pending!)).toBe('Radar 1 km')

    const a = derivePlay([started, asked, ev('question_answered', { question_id: 'q1', answer: 'yes', late: false })])
    expect(a.pending).toBeNull()
    expect(a.questions[0].answer).toBe('yes')
    expect(shadable(a)).toHaveLength(1)
  })

  it('logs a missed deadline once and keeps the late answer', () => {
    const s = derivePlay([
      started,
      asked,
      ev('answer_overdue', { question_id: 'q1', penalty: 'shot', team: 'hiders' }),
      ev('question_answered', { question_id: 'q1', answer: 'no', late: true }),
    ])
    expect(s.penalties).toBe(1)
    expect(s.questions[0]).toMatchObject({ overdue: true, late: true, answer: 'no' })
    expect(s.log.map((l) => l.kind)).toEqual(['asked', 'penalty', 'answered'])
  })

  it('logs the hider-only bar lock-in as private', () => {
    const s = derivePlay([started, ev('bar_chosen', { venue_id: 'v', name: 'Pub', lng: 153, lat: -27 }, 'hiders')])
    expect(s.log[0]).toMatchObject({ kind: 'bar', text: 'Locked in Pub', private: true })
  })
})

describe('dueTimer', () => {
  it('asks to settle when the hiding period or a deadline is over', () => {
    const s = derivePlay([started])
    expect(dueTimer(s, T0 + 1799_000)).toBeNull()
    expect(dueTimer(s, T0 + 1800_000)).toBe('seeking:1')

    const p = derivePlay([started, ev('seeking_started', {}), asked])
    expect(dueTimer(p, Date.parse('2026-11-20T09:44:59Z'))).toBeNull()
    expect(dueTimer(p, Date.parse('2026-11-20T09:45:00Z'))).toBe('overdue:q1')

    const done = derivePlay([started, ev('seeking_started', {}), asked, ev('answer_overdue', { question_id: 'q1' })])
    expect(dueTimer(done, Date.parse('2026-11-20T09:50:00Z'))).toBeNull()
  })
})

describe('powerups on questions', () => {
  const vetoCard = { card_id: 'veto', name: 'Veto', behaviour: 'powerup', params: { action: 'veto' } }
  const randCard = { card_id: 'randomize', name: 'Randomize', behaviour: 'powerup', params: { action: 'randomize' } }

  it('a vetoed question closes with no answer and is not shaded', () => {
    const s = derivePlay([started, asked, ev('card_played', { card: vetoCard, question_id: 'q1', played_at: '2026-11-20T09:41:00Z' })])
    expect(s.pending).toBeNull()
    expect(s.questions[0].closedBy).toBe('veto')
    expect(outcomeText(s.questions[0])).toBe('Vetoed')
    expect(shadable(s)).toEqual([])
  })

  it('randomize closes the question and the new one is pending', () => {
    const next = ev('question_asked', {
      ...asked.payload,
      question_id: 'q2',
      option_id: '3km',
      params: { center: [153, -27], distance_m: 3000 },
      randomized_from: 'q1',
    })
    const s = derivePlay([started, asked, ev('card_played', { card: randCard, question_id: 'q1' }), next])
    expect(s.questions.map((q) => q.closedBy)).toEqual(['randomize', null])
    expect(s.pending?.id).toBe('q2')
    expect(s.log.at(-1)?.text).toBe('Randomized into Radar 3 km')
  })

  it('answers from before a move are not shaded', () => {
    const answered = ev('question_answered', { question_id: 'q1', answer: 'yes' })
    expect(shadable(derivePlay([started, asked, answered]))).toHaveLength(1)
    expect(shadable(derivePlay([started, asked, answered, ev('hider_moved', {})]))).toEqual([])
  })

  it('a doubled reward is kept on the answer', () => {
    const s = derivePlay([
      started,
      asked,
      ev('question_answered', { question_id: 'q1', answer: 'yes', reward_multiplier: 2, reward: { draw: 4, pick: 2 } }),
    ])
    expect(s.questions[0]).toMatchObject({ rewardMultiplier: 2, reward: { draw: 4, pick: 2 } })
  })
})
