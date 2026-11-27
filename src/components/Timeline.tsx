import { useContext, type CSSProperties } from 'react'
import type { LobbyState } from '../lobby/state'
import { clockLabel, formatClock, hidingPeriodAt } from '../hiding/state'
import { buildTimeline, answerPhoto, type TimelineItem } from '../play/timeline'
import { questionTool } from '../play/overlays'
import { typeColour, type QuestionType } from '../play/questionTypes'
import { outcomeText, questionText, typeName, type LogEntry, type Question } from '../play/state'
import { HiderCountContext, PrivateWordContext } from './hiderCount'
import { LockIcon } from './PrivateLabel'
import { PhotoThumb } from './PhotoThumb'
import { CardInfoButton } from './CardFace'
import { castCost, costPayer, COST_LABEL, effectPhase, type CardsState, type PlayedCard } from '../cards/state'

interface Props {
  questions: readonly Question[]
  log: readonly LogEntry[]
  /** Card state: curses played, their effects, vetoes and bans. */
  cards: CardsState
  /** Server time now, for running curse timers. */
  now: number
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
export function Timeline({ questions, log, cards, now, lobby, types, team, round, canAct, shownId, onShow, onShade, nameOf }: Props) {
  // Times read like the main clock: from when seeking started (−m:ss while hiding).
  const started = lobby.started
  const clock = (at: number) => (started ? clockLabel(at, started.startedAt, hidingPeriodAt(started, now), started.pauses) : '')
  const items = buildTimeline(questions, log, cards.played)
  return (
    <section className="card">
      <h2>Timeline</h2>
      {items.length === 0 ? (
        <p className="muted">Nothing yet. Questions, answers and cards show up here.</p>
      ) : (
        <ol className="timeline">
          {items.map((it) => (
            <TimelineItemView
              key={it.kind === 'entry' ? `e${it.seq}` : it.kind === 'curse' ? `c${it.played.instanceId}` : it.question.id}
              it={it}
              log={log}
              cards={cards}
              now={now}
              types={types}
              clock={clock}
              nameOf={nameOf}
              canShade={it.kind === 'question' && team === 'seekers' && canAct && it.question.round === round && it.question.answer !== null}
              shownId={shownId}
              onShow={onShow}
              onShade={onShade}
            />
          ))}
        </ol>
      )}
    </section>
  )
}

interface ItemProps {
  it: TimelineItem
  log: readonly LogEntry[]
  cards: CardsState
  now: number
  types: readonly QuestionType[] | null
  clock: (at: number) => string
  nameOf: (userId: string | null) => string
  canShade?: boolean
  shownId?: string | null
  onShow?: (q: Question) => void
  onShade?: (q: Question) => void
}

/** One timeline item (question, curse or row), also used by the end-of-game replay. */
export function TimelineItemView({ it, log, cards, now, types, clock, nameOf, canShade = false, shownId = null, onShow, onShade }: ItemProps) {
  if (it.kind === 'entry') return <Row entry={it.entry} clock={clock} />
  if (it.kind === 'curse') return <CurseCard played={it.played} entries={it.entries} cards={cards} now={now} clock={clock} />
  return (
    <QuestionCard
      q={it.question}
      entries={it.entries}
      photo={answerPhoto(log, it.question.id)}
      colour={typeColour(types, it.question.type) ?? FALLBACK}
      clock={clock}
      asker={nameOf(it.question.askedBy)}
      canShade={canShade}
      shown={shownId === it.question.id}
      onShow={onShow}
      onShade={onShade}
    />
  )
}

function Time({ label }: { label: string }) {
  return <span className="log-time">{label}</span>
}

function Private() {
  const hiders = useContext(HiderCountContext)
  const word = useContext(PrivateWordContext)
  return (
    <span className="muted small">
      {' '}
      <LockIcon /> {word ?? (hiders > 1 ? 'only your team' : 'only you')}
    </span>
  )
}

/** Where a played curse is now, in words. */
function curseStatus(p: PlayedCard, cards: CardsState, now: number): string {
  if (cards.vetoes.some((v) => v.instanceId === p.instanceId)) return 'Vetoed by the seekers'
  const bans = cards.bans.filter((b) => b.instanceId === p.instanceId).map((b) => b.label)
  if (bans.length) return `Banned for the run: ${bans.join(', ')}`
  const e = p.effectId ? cards.effects.find((x) => x.id === p.effectId) : null
  if (!e) return 'Played'
  switch (effectPhase(e, now)) {
    case 'running':
      return `Running: ${formatClock(Math.max(0, (e.endsAt ?? now) - now))} left`
    case 'followup_available':
      return 'Time is up'
    case 'followup':
      return `Follow-on running: ${formatClock(Math.max(0, (e.followupEndsAt ?? now) - now))} left`
    case 'until_cleared':
      if (e.trivia) return 'Trivia in progress'
      return e.blocksQuestions ? "In force: seekers can't ask questions until they do it" : 'In force until the seekers do it'
    case 'awaiting_confirm':
      return 'Seekers say they did it: waiting for the hider to confirm'
    case 'awaiting_seekers':
      return 'Waiting for the seekers to say if it applies'
    case 'over':
      return e.status === 'cleared' ? 'Done' : 'Over'
  }
}

/** A played curse: the card, what casting it cost and who drinks, its status, and the replies. */
function CurseCard({
  played: p,
  entries,
  cards,
  now,
  clock,
}: {
  played: PlayedCard
  entries: readonly LogEntry[]
  cards: CardsState
  now: number
  clock: (at: number) => string
}) {
  const c = p.card
  const cost = castCost(c)
  const status = curseStatus(p, cards, now)
  const live = !/^(Done|Over|Vetoed)/.test(status)
  return (
    <li className={`tl-question tl-curse${live ? ' tl-open' : ''}`} style={{ '--type': c.colour } as CSSProperties}>
      <div className="tl-head">
        <span className="tl-type">{c.categoryName || 'Curse'}</span>
        <span className="tl-head-end">
          <Time label={clock(p.playedAt)} />
          <CardInfoButton card={c} />
        </span>
      </div>
      <p className="tl-text">{c.name}</p>
      {c.text && <p className="tl-card-text">{c.text}</p>}
      <p className="small">
        Cast cost: <strong>{cost ? `${COST_LABEL[cost]}, drunk by the ${costPayer(c)}` : 'Free'}</strong>
        {c.canVeto === false && <span className="muted"> · Can't veto</span>}
      </p>
      <p className="tl-answer">
        <strong>{status}</strong>
      </p>
      {entries.length > 0 && (
        <ul className="tl-sub">
          {entries.map((l) => (
            <li key={l.seq} className={`log-${l.kind}`}>
              <span className="log-dot" style={l.colour ? { background: l.colour } : undefined} aria-hidden="true" />
              <span>
                <FixText l={l} /> <span className="muted small">{clock(l.at)}</span>
                {l.photo && <PhotoThumb path={l.photo} bucket={l.photoBucket} alt="Proof photo" />}
                {l.private && <Private />}
              </span>
            </li>
          ))}
        </ul>
      )}
    </li>
  )
}

/** An entry's text; host fixes (overrides) are tagged, with the reason and whether it was undone. */
function FixText({ l }: { l: LogEntry }) {
  if (l.kind !== 'override') return <>{l.text}</>
  return (
    <>
      <span className="tl-fix">Host fix</span> <span className={l.undone ? 'tl-undone' : undefined}>{l.text}</span>
      {l.reason && <span className="muted"> · “{l.reason}”</span>}
      {l.undone && <span className="muted"> (undone)</span>}
    </>
  )
}

function Row({ entry: l, clock }: { entry: LogEntry; clock: (at: number) => string }) {
  return (
    <li className={`tl-row log-${l.kind}`}>
      <span className="log-dot" style={l.colour ? { background: l.colour } : undefined} aria-hidden="true" />
      <Time label={clock(l.at)} />
      <span>
        <FixText l={l} />
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
  clock: (at: number) => string
  asker: string
  canShade: boolean
  shown: boolean
  onShow?: (q: Question) => void
  onShade?: (q: Question) => void
}

function QuestionCard({ q, entries, photo, colour, clock, asker, canShade, shown, onShow, onShade }: CardProps) {
  const open = q.answer === null && q.closedBy === null
  const mult = q.rewardMultiplier && q.rewardMultiplier !== 1 ? ` (×${q.rewardMultiplier})` : ''
  const mappable = !!onShow && questionTool(q).features.length > 0
  const manual = q.manualShading
  return (
    <li className={`tl-question${open ? ' tl-open' : ''}`} style={{ '--type': colour } as CSSProperties}>
      <div className="tl-head">
        <span className="tl-type">{typeName(q.type)}</span>
        <Time label={clock(q.askedAt)} />
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
            {q.answeredAt !== null && <span className="muted small"> · {clock(q.answeredAt)}</span>}
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
                <FixText l={l} />
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
            <button className="secondary small" aria-pressed={shown} onClick={() => onShow?.(q)}>
              {shown ? 'On the map' : 'Show on map'}
            </button>
          )}
          {canShade && (
            <button className="secondary small" onClick={() => onShade?.(q)}>
              Shade by hand
            </button>
          )}
        </div>
      )}
    </li>
  )
}
