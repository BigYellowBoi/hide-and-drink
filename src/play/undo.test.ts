import { describe, expect, it } from 'vitest'
import type { GameEvent } from '../sync/types'
import { undoLabel, undoTarget, withoutUndone } from './undo'

let seq = 0
const ev = (type: string, payload: Record<string, unknown> = {}, visibility: GameEvent['visibility'] = 'all'): GameEvent => ({
  game_id: 'g',
  seq: ++seq,
  type,
  visibility,
  actor_id: null,
  payload,
  created_at: new Date(0).toISOString(),
})

describe('host undo', () => {
  it('drops undone events and keeps the rest', () => {
    seq = 0
    const asked = ev('question_asked', { question_id: 'q1', type: 'radar' })
    const answered = ev('question_answered', { question_id: 'q1', type: 'radar' })
    const drawn = ev('cards_drawn', { question_id: 'q1' }, 'hiders')
    const undo = ev('action_undone', { seq: answered.seq, type: 'question_answered' })
    const undoDraw = ev('action_undone', { seq: drawn.seq, type: 'cards_drawn' }, 'hiders')
    const out = withoutUndone([asked, answered, drawn, undo, undoDraw])
    expect(out.map((e) => e.seq)).toEqual([asked.seq, undo.seq, undoDraw.seq])
  })

  it('returns the same array when nothing was undone', () => {
    seq = 0
    const events = [ev('game_started'), ev('question_asked', { question_id: 'q1' })]
    expect(withoutUndone(events)).toBe(events)
  })

  it('targets the latest public event if it is undoable', () => {
    seq = 0
    const events = [
      ev('game_started'),
      ev('question_asked', { question_id: 'q1', type: 'thermometer' }),
      ev('question_answered', { question_id: 'q1', type: 'thermometer' }),
      ev('cards_drawn', {}, 'hiders'),
    ]
    expect(undoTarget(events)).toEqual({ seq: 3, type: 'question_answered', questionId: 'q1', questionType: 'thermometer' })
  })

  it('passes over seeking_started and earlier undos', () => {
    seq = 0
    const asked = ev('question_asked', { question_id: 'q1', type: 'radar' })
    const shaded = ev('question_shading_set', { question_id: 'q1' })
    const events = withoutUndone([ev('game_started'), asked, shaded, ev('action_undone', { seq: shaded.seq }), ev('seeking_started')])
    expect(undoTarget(events)?.seq).toBe(asked.seq)
  })

  it('names the question type for shading from its ask', () => {
    seq = 0
    const events = [ev('question_asked', { question_id: 'q1', type: 'radar' }), ev('question_shading_set', { question_id: 'q1' })]
    expect(undoTarget(events)?.questionType).toBe('radar')
  })

  it('offers nothing when the latest public event is not undoable', () => {
    seq = 0
    expect(undoTarget([ev('question_asked', { question_id: 'q1' }), ev('card_played')])).toBeNull()
    expect(undoTarget([ev('game_started')])).toBeNull()
  })

  it('labels the target', () => {
    expect(undoLabel('question_answered', 'radar')).toBe('Radar answer')
    expect(undoLabel('question_asked', null)).toBe('Question asked')
  })
})
