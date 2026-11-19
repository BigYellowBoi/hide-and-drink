import { clockLabel } from '../hiding/state'
import { deriveRounds, formatDuration } from '../rounds/state'
import { outcomeText, questionText, typeName, type LogEntry } from '../play/state'
import type { ReplayData } from './api'
import type { Replay, ReplayStep } from './state'

/** Where a media file sits in the download zip. */
export const zipMediaPath = (name: string) => `media/${name}`

const when = (ms: number, timeZone?: string) =>
  Number.isFinite(ms)
    ? new Intl.DateTimeFormat('en-AU', {
        timeZone,
        weekday: 'short',
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(ms)
    : '?'

const photoNote = (l: Pick<LogEntry, 'photo'>) => (l.photo ? ` [${zipMediaPath(l.photo)}]` : '')
const lock = (l: Pick<LogEntry, 'private'>) => (l.private ? ' (hiders only)' : '')

/** One step as text lines (the first one carries the clock). */
export function stepLines(step: ReplayStep, replay: Replay, nameOf: (id: string | null) => string): string[] {
  const r = replay.rounds.find((x) => x.round === step.round)
  const clock = r ? clockLabel(step.at, r.started.startedAt, r.started.hidingPeriodS) : ''
  if (step.kind !== 'item') return []
  const it = step.item
  const sub = (entries: readonly LogEntry[]) => entries.map((l) => `      ${l.text}${photoNote(l)}${lock(l)}`)
  if (it.kind === 'question') {
    const q = it.question
    const photo = r?.log.find((l) => l.questionId === q.id && l.kind === 'answered' && l.photo)
    const answer = q.answer === null && q.closedBy === null ? 'no answer' : outcomeText(q)
    return [
      `  ${clock}  ${typeName(q.type)}: ${questionText(q)} (asked by ${nameOf(q.askedBy)})`,
      `      Answer: ${answer}${q.late ? ' (late)' : ''}${photo ? photoNote(photo) : ''}`,
      ...sub(it.entries),
    ]
  }
  if (it.kind === 'curse') {
    const c = it.played.card
    return [`  ${clock}  ${c.categoryName || 'Curse'}: ${c.name}${c.text ? `: ${c.text}` : ''}`, ...sub(it.entries)]
  }
  return [`  ${clock}  ${it.entry.text}${photoNote(it.entry)}${lock(it.entry)}`]
}

/** A readable account of the whole game, for the download. */
export function gameSummary(data: ReplayData, replay: Replay, timeZone?: string): string {
  const names = new Map(data.players.map((p) => [p.user_id, p.name]))
  const nameOf = (id: string | null) => (id ? (names.get(id) ?? 'Player') : 'Someone')
  const scores = deriveRounds(replay.events)
  const lines: string[] = []
  const area = replay.rounds[0]?.started.playAreaName
  lines.push('Hide + Drink game')
  lines.push(`Code ${data.game.code} · ${data.game.city.charAt(0).toUpperCase()}${data.game.city.slice(1)}${area ? ` · ${area}` : ''}`)
  lines.push(`Started ${when(replay.start, timeZone)}, ended ${when(Date.parse(data.game.ended_at ?? ''), timeZone)}`)
  lines.push(`Players: ${data.players.map((p) => p.name).join(', ')}`)
  const winners = scores.result?.winners ?? []
  lines.push(winners.length ? `Winner: ${winners.map((w) => nameOf(w)).join(' and ')}` : 'No winner')
  if (scores.rounds.length) {
    const totals = new Map<string, number>()
    for (const sr of scores.rounds) if (!sr.voided) for (const h of sr.hiders) totals.set(h.userId, (totals.get(h.userId) ?? 0) + sr.totalS)
    lines.push('Totals (time hidden):')
    for (const [id, s] of [...totals].sort((a, b) => b[1] - a[1])) lines.push(`  ${nameOf(id)}: ${formatDuration(s)}`)
  }
  for (const r of replay.rounds) {
    const score = scores.rounds.find((s) => s.round === r.round)
    lines.push('')
    lines.push(`Round ${r.round}`)
    lines.push(`Hiders: ${r.hiders.map((h) => nameOf(h)).join(', ') || '?'}`)
    if (r.bar) lines.push(`Hid at: ${r.bar.name} (${r.bar.lat.toFixed(5)}, ${r.bar.lng.toFixed(5)})`)
    if (score) lines.push(score.voided ? 'Redone: does not count' : `Score: ${formatDuration(score.totalS)}`)
    for (const step of replay.steps) if (step.round === r.round) lines.push(...stepLines(step, replay, nameOf))
  }
  lines.push('')
  lines.push('Times: −m:ss is time left to hide, +m:ss is time since seeking started.')
  lines.push('events.json has every event, every player\'s recorded positions and the media list.')
  return lines.join('\n') + '\n'
}
