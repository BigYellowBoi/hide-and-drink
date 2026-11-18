import type { GameEvent } from '../sync/types'
import { undoLabel } from './state'

export { undoLabel }

/**
 * Host undo (undo_last_action): the server appends action_undone {seq} naming each event it
 * took back. Every phone drops those events before deriving any state, so an undone ask,
 * answer or shading (and the hider's reward draw) disappears everywhere at once.
 */

export const UNDOABLE = ['question_asked', 'question_answered', 'question_shading_set'] as const
export type UndoableType = (typeof UNDOABLE)[number]

/** Events the server passes over when looking for the action to undo. */
const PASSED_OVER = new Set(['action_undone', 'seeking_started'])

const undoneSeqs = (events: readonly GameEvent[]): Set<number> => {
  const s = new Set<number>()
  for (const e of events) if (e.type === 'action_undone' && typeof e.payload.seq === 'number') s.add(e.payload.seq)
  return s
}

/** The events with every undone one left out (the action_undone events themselves stay). */
export function withoutUndone(events: readonly GameEvent[]): readonly GameEvent[] {
  if (!events.some((e) => e.type === 'action_undone')) return events
  const undone = undoneSeqs(events)
  return events.filter((e) => !undone.has(e.seq))
}

export interface UndoTarget {
  seq: number
  type: UndoableType
  questionId: string | null
  questionType: string | null
}

/**
 * What Undo would take back, from events already passed through withoutUndone: the latest
 * public event, if it is an undoable one. Mirrors the server, which decides.
 */
export function undoTarget(events: readonly GameEvent[]): UndoTarget | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.visibility !== 'all' || PASSED_OVER.has(e.type)) continue
    if (!(UNDOABLE as readonly string[]).includes(e.type)) return null
    const qid = typeof e.payload.question_id === 'string' ? e.payload.question_id : null
    const asked = qid ? events.find((x) => x.type === 'question_asked' && x.payload.question_id === qid) : undefined
    const qtype = typeof e.payload.type === 'string' && e.type !== 'question_shading_set' ? e.payload.type : asked?.payload.type
    return { seq: e.seq, type: e.type as UndoableType, questionId: qid, questionType: typeof qtype === 'string' ? qtype : null }
  }
  return null
}
