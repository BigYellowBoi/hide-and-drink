import { Suspense, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { describeError } from '../lobby/messages'
import { questionTool } from '../play/overlays'
import { suggestAnswer, type HiderZone } from '../play/shading'
import { ANSWERS, answerLabel, isSupportedType, km, questionLabel, type Question } from '../play/state'
import { LockIcon } from './BarPicker'
import { DeadlineRing } from './DeadlineRing'
import type { MapDot } from './GameMap'
import { LazyGameMap } from './lazyMap'

interface Props {
  sync: GameSync
  question: Question
  askerName: string
  city: string
  playArea: AreaCollection | null
  zone: HiderZone
  ruled: FeatureCollection
  /** Seekers' positions, with name tags. */
  seekers: readonly MapDot[]
  canAct: boolean
  now: number
}

/** Fill the prompt's blank with the question's distance. */
const promptText = (q: Question) =>
  q.prompt.replace('___', typeof q.params.distance_m === 'number' ? km(q.params.distance_m) : '___')

/**
 * Hider's answer sheet: sits at the top until answered. The suggestion is only a
 * suggestion; nothing is sent until the hider picks an answer and taps Send.
 */
export function AnswerSheet({ sync, question: q, askerName, city, playArea, zone, ruled, seekers, canAct, now }: Props) {
  const [choice, setChoice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const suggestion = useMemo(() => suggestAnswer(q, zone), [q, zone])
  const late = now > q.deadlineAt
  const answers = isSupportedType(q.type) ? ANSWERS[q.type] : []

  const overlay = useMemo(
    () => ({
      tool: questionTool(q),
      ruled,
      zone: zone.bar ? { lng: zone.bar.point[0], lat: zone.bar.point[1], radiusM: zone.bar.radiusM, team: 'hiders' as const } : null,
      dots: [
        ...seekers,
        ...(zone.gps ? [{ id: 'me', lng: zone.gps.point[0], lat: zone.gps.point[1], team: 'hiders' as const, me: true }] : []),
      ],
    }),
    [q, ruled, zone, seekers],
  )

  const send = async () => {
    if (!choice) return
    setBusy(true)
    setErr(null)
    try {
      await sync.action('answer_question', { p_question_id: q.id, p_answer: choice })
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card answer-sheet" aria-live="polite">
      <div className="sheet-head">
        <div>
          <p className="eyebrow">New question · from {askerName}</p>
          <h2>{questionLabel(q)}</h2>
          <p className="muted">{promptText(q)}</p>
        </div>
        <DeadlineRing endsAt={q.deadlineAt} totalS={q.deadlineS} now={now} />
      </div>

      <Suspense fallback={<div className="game-map mini-map" />}>
        <LazyGameMap city={city} playArea={playArea} className="mini-map" overlay={overlay} tapNames={false} />
      </Suspense>

      <div className="suggestion">
        <p className="eyebrow">
          <LockIcon /> Only you see this
        </p>
        {suggestion ? (
          <>
            <p>
              Suggested: <strong>{answerLabel(suggestion.answer)}</strong>{' '}
              <span className="muted small">
                (from your {suggestion.from === 'bar' ? 'bar' : 'GPS position'})
              </span>
            </p>
            {suggestion.differs && (
              <p className="flag">
                Could be either: part of your {zone.bar ? `${zone.bar.radiusM} m circle` : 'GPS accuracy'} gets the other
                answer. Check where you are.
              </p>
            )}
          </>
        ) : (
          <p className="muted">No suggestion: lock in a bar or allow location.</p>
        )}
      </div>

      <div className="answer-buttons">
        {answers.map((a) => (
          <button
            key={a}
            className={`answer${choice === a ? ' on' : ''}`}
            aria-pressed={choice === a}
            disabled={busy || !canAct}
            onClick={() => setChoice(a)}
          >
            {answerLabel(a)}
          </button>
        ))}
      </div>
      <button className="wide" disabled={!choice || busy || !canAct} onClick={() => void send()}>
        {choice ? `Send “${answerLabel(choice)}”` : 'Pick an answer'}
      </button>
      {late && <p className="flag">Deadline passed: a shot for your team is logged. You still need to answer.</p>}
      <p className="muted small">
        Answering earns you: draw {q.reward.draw}, keep {q.reward.pick}.
      </p>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
