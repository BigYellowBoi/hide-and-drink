import type { LogEntry, Question } from './state'
import type { PlayedCard } from '../cards/state'

/**
 * The game's activity log as one timeline: each question is one item carrying what followed
 * from it (cards drawn and kept for it, a veto, a missed deadline, manual shading); each curse
 * is one item carrying its cast cost drink, the seekers' replies, proofs and a veto; everything
 * else (other cards played, drink proofs) is an item of its own. Newest first.
 */
export type TimelineItem =
  | { kind: 'question'; seq: number; at: number; question: Question; entries: LogEntry[] }
  | { kind: 'curse'; seq: number; at: number; played: PlayedCard; entries: LogEntry[] }
  | { kind: 'entry'; seq: number; at: number; entry: LogEntry }

/** Entries a question card already shows from the question itself. */
const SHOWN_BY_CARD = new Set<LogEntry['kind']>(['asked', 'answered'])

/** Played cards the timeline shows as a card of their own. */
export const isCurse = (p: PlayedCard) => p.card.category === 'curse'

export function buildTimeline(questions: readonly Question[], log: readonly LogEntry[], played: readonly PlayedCard[] = []): TimelineItem[] {
  const byId = new Map(questions.map((q) => [q.id, q]))
  const curses = new Map(played.filter(isCurse).map((p) => [p.instanceId, p]))
  const attached = new Map<string, LogEntry[]>()
  const attach = (key: string, l: LogEntry) => {
    let list = attached.get(key)
    if (!list) attached.set(key, (list = []))
    list.push(l)
  }
  const items: TimelineItem[] = []
  for (const l of [...log].sort((a, b) => a.seq - b.seq)) {
    const q = l.questionId ? byId.get(l.questionId) : undefined
    if (q) {
      if (!SHOWN_BY_CARD.has(l.kind)) attach(q.id, l)
      continue
    }
    const c = l.instanceId ? curses.get(l.instanceId) : undefined
    if (c) {
      // The "played" entry is the curse card itself.
      if (l.seq !== c.seq) attach(`c:${c.instanceId}`, l)
      continue
    }
    items.push({ kind: 'entry', seq: l.seq, at: l.at, entry: l })
  }
  for (const q of questions) items.push({ kind: 'question', seq: q.seq, at: q.askedAt, question: q, entries: attached.get(q.id) ?? [] })
  for (const c of curses.values()) items.push({ kind: 'curse', seq: c.seq, at: c.playedAt, played: c, entries: attached.get(`c:${c.instanceId}`) ?? [] })
  return items.sort((a, b) => b.seq - a.seq)
}

/** The answer photo of a question (photos type), if any. */
export const answerPhoto = (log: readonly LogEntry[], questionId: string): string | null =>
  log.find((l) => l.questionId === questionId && l.kind === 'answered' && l.photo)?.photo ?? null
