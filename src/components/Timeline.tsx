import { useContext, type CSSProperties } from 'react'
import type { LobbyState } from '../lobby/state'
import { formatClock } from '../hiding/state'
import { buildTimeline, answerPhoto } from '../play/timeline'
import { questionTool } from '../play/overlays'
import { typeColour, type QuestionType } from '../play/questionTypes'
import { outcomeText, questionText, typeName, type LogEntry, type Question } from '../play/state'
import { HiderCountContext } from './hiderCount'
import { LockIcon } from './PrivateLabel'
import { PhotoThumb } from './PhotoThumb'

interface Props {
  questions: readonly Question[]
  log: readonly LogEntry[]
  lobby: LobbyState
  types: readonly QuestionType[] | null
  /** This phone's team: seekers can shade answers by hand. */
  team: 'hiders' | 'seekers' | null
  /** The current round (only its answers can be shaded by hand). */
  round: number
  canAct: boolean
  /** Question shown on the map right now (Show on map). */
  shownId: string | null
  onShow: (q: Question) => void
  onShade: (q: Question) => void
  nameOf: (userId: string | null) => string
}

const FALLBACK = '#A9B4BF'

/**
 * The game's activity log, newest first: one card per question (question, answer, who asked,
 * cards drawn and played for it, photo) and a row for everything else (cards played, curses
 * cleared, drink proofs, penalties in amber). Hider-only rows carry a lock.
 */
export function Timeline({ questions, log, lobby, types, team, round, canAct, shownId, onShow, onShade, nameOf }: Props) {
  const roundStart = lobby.started?.startedAt ?? 0
  const items = buildTimeline(questions, log)
  return (
    <section className="card">
      <h2>Timeline</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Questions, answers and cards show up here.</p>
      ) : (
        <ol className="timeline">
          {items.map((it) =>
            it.kind === 'entry' ? (
              <Row key={`e${it.seq}`} entry={it.entry} roundStart={roundStart} />
            ) : (
              <QuestionCard
                key={it.question.id}
                q={it.question}
                entries={it.entries}
                photo={answerPhoto(log, it.question.id)}
                colour={typeColour(types, it.question.type) ?? FALLBACK}
                roundStart={roundStart}
                asker={nameOf(it.question.askedBy)}
                canShade={team === 'seekers' && canAct && it.question.round === round && it.question.answer !== null}
                shown={shownId === it.question.id}
                onShow={onShow}
                onShade={onShade}
              />
            ),
          )}
        </ol>
      )}
    </section>
  )
}

function Time({ at, roundStart }: { at: number; roundStart: number }) {
  return <span className="log-time">+{formatClock(Math.max(0, at - roundStart), { up: true })}</span>
}

function Private() {
  const hiders = useContext(HiderCountContext)
  return (
    <span className="muted small">
      {' '}
      <LockIcon /> {hiders > 1 ? 'only your team' : 'only you'}
    </span>
  )
}

function Row({ entry: l, roundStart }: { entry: LogEntry; roundStart: number }) {
  return (
    <li className={`tl-row log-${l.kind}`}>
      <span className="log-dot" style={l.colour ? { background: l.colour } : undefined} aria-hidden="true" />
      <Time at={l.at} roundStart={roundStart} />
      <span>
        {l.text}
        {l.photo && <PhotoThumb path={l.photo} bucket={l.photoBucket} alt={l.photoBucket ? 'Proof photo' : 'Answer photo'} />}
        {l.private && <Private />}
      </span>
    </li>
  )
}

interface CardProps {
  q: Question
  entries: readonly LogEntry[]
  photo: string | null
  colour: string
  roundStart: number
  asker: string
  canShade: boolean
  shown: boolean
  onShow: (q: Question) => void
  onShade: (q: Question) => void
}

function QuestionCard({ q, entries, photo, colour, roundStart, asker, canShade, shown, onShow, onShade }: CardProps) {
  const open = q.answer === null && q.closedBy === null
  const mult = q.rewardMultiplier && q.rewardMultiplier !== 1 ? ` (×${q.rewardMultiplier})` : ''
  const mappable = questionTool(q).features.length > 0
  const manual = q.manualShading
  return (
    <li className={`tl-question${open ? ' tl-open' : ''}`} style={{ '--type': colour } as CSSProperties}>
      <div className="tl-head">
        <span className="tl-type">{typeName(q.type)}</span>
        <Time at={q.askedAt} roundStart={roundStart} />
      </div>
      <p className="tl-text">{questionText(q)}</p>
      <p className="muted small">Asked by {asker}</p>
      <p className="tl-answer">
        {open ? (
          <span className="muted">Waiting for the answer</span>
        ) : (
          <>
            {q.closedBy ? '' : 'Answer: '}
            <strong>{outcomeText(q)}</strong>
            {q.late && <span className="penalty"> · late</span>}
            {q.answeredAt !== null && <span className="muted small"> · +{formatClock(Math.max(0, q.answeredAt - roundStart), { up: true })}</span>}
          </>
        )}
      </p>
      {photo && <PhotoThumb path={photo} />}
      {q.answer !== null && (
        <p className="muted small">
          Reward: hiders draw {q.reward.draw}, keep {q.reward.pick}
          {mult}
        </p>
      )}
      {entries.length > 0 && (
        <ul className="tl-sub">
          {entries.map((l) => (
            <li key={l.seq} className={`log-${l.kind}`}>
              <span className="log-dot" style={l.colour ? { background: l.colour } : undefined} aria-hidden="true" />
              <span>
                {l.text}
                {l.photo && <PhotoThumb path={l.photo} bucket={l.photoBucket} alt="Proof photo" />}
                {l.private && <Private />}
              </span>
            </li>
          ))}
        </ul>
      )}
      {manual && <p className="tl-manual small">Shaded by hand{manual.mode === 'none' ? ': rules nothing out' : ''}</p>}
      {(mappable || canShade) && (
        <div className="row tl-actions">
          {mappable && (
            <button className="secondary small" aria-pressed={shown} onClick={() => onShow(q)}>
              {shown ? 'On the map' : 'Show on map'}
            </button>
          )}
          {canShade && (
            <button className="secondary small" onClick={() => onShade(q)}>
              Shade by hand
            </button>
          )}
        </div>
      )}
    </li>
  )
}
