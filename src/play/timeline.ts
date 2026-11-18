import type { LogEntry, Question } from './state'

/**
 * The game's activity log as one timeline: each question is one item carrying what followed
 * from it (cards drawn and kept for it, a veto, a missed deadline, manual shading); everything
 * else (cards played, curses cleared, drink proofs) is an item of its own. Newest first.
 */
export type TimelineItem =
  | { kind: 'question'; seq: number; at: number; question: Question; entries: LogEntry[] }
  | { kind: 'entry'; seq: number; at: number; entry: LogEntry }

/** Entries a question card already shows from the question itself. */
const SHOWN_BY_CARD = new Set<LogEntry['kind']>(['asked', 'answered'])

export function buildTimeline(questions: readonly Question[], log: readonly LogEntry[]): TimelineItem[] {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const attached = new Map<string, LogEntry[]>()
  const items: TimelineItem[] = []
  for (const l of [...log].sort((a, b) => a.seq - b.seq)) {
    const q = l.questionId ? byId.get(l.questionId) : undefined
    if (!q) {
      items.push({ kind: 'entry', seq: l.seq, at: l.at, entry: l })
      continue
    }
    if (SHOWN_BY_CARD.has(l.kind)) continue
    let list = attached.get(q.id)
    if (!list) attached.set(q.id, (list = []))
    list.push(l)
  }
  for (const q of questions) items.push({ kind: 'question', seq: q.seq, at: q.askedAt, question: q, entries: attached.get(q.id) ?? [] })
  return items.sort((a, b) => b.seq - a.seq)
}

/** The answer photo of a question (photos type), if any. */
export const answerPhoto = (log: readonly LogEntry[], questionId: string): string | null =>
  log.find((l) => l.questionId === questionId && l.kind === 'answered' && l.photo)?.photo ?? null
