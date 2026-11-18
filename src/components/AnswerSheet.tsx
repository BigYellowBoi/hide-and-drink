import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { describeError } from '../lobby/messages'
import { questionTool } from '../play/overlays'
import { isLngLat } from '../play/geo'
import { suggestAnswer, type HiderZone } from '../play/shading'
import type { LayerLookup } from '../play/features'
import type { VenueEdits } from '../venues/state'
import { photoPath, shrinkPhoto, uploadPhoto } from '../play/photos'
import { supabase } from '../lib/supabase'
import { ANSWERS, answerText, candidatesOf, km, NULL_ANSWER, optionText, questionLabel, questionText, shownEnd, type Question } from '../play/state'
import { LockIcon, PrivateLabel } from './PrivateLabel'
import { DeadlineRing } from './DeadlineRing'
import { useTimerAlert } from '../lib/useTimerAlert'
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
  /** City pack features, for suggestions that need them (matching, bonus count rules). */
  layer?: LayerLookup
  /** The game's venue edits, for the venue dots on the mini map. */
  venues?: VenueEdits
  /** Veto / Randomize cards in the hand: play one instead of answering. */
  powerups?: readonly { instanceId: string; name: string; action: 'veto' | 'randomize' }[]
  /** The answer's reward is multiplied by this (next_question_modifier cards). */
  rewardMultiplier?: number
}

interface Photo {
  blob: Blob
  url: string
  path: string
}

/**
 * Hider's answer sheet: sits at the top until answered. The suggestion is only a
 * suggestion; nothing is sent until the hider picks an answer and taps Send.
 */
export function AnswerSheet({
  sync,
  question: q,
  askerName,
  city,
  playArea,
  zone,
  ruled,
  seekers,
  canAct,
  now,
  layer,
  venues,
  powerups = [],
  rewardMultiplier = 1,
}: Props) {
  const [choice, setChoice] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [photo, setPhoto] = useState<Photo | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const suggestion = useMemo(() => suggestAnswer(q, zone, layer), [q, zone, layer])
  const late = now > q.deadlineAt
  // Buzz the hider's phone a minute before the deadline and when it passes.
  useTimerAlert(`answer:${q.id}`, shownEnd(q.deadlineAt, q.pausedLeftMs, now) - now)
  const kind = q.type === 'bonus' ? String(q.params.answer_kind ?? 'text') : q.type
  const nullLabel = typeof q.params.null_answer === 'string' ? q.params.null_answer : null

  // Every way to answer this question, as [answer, label] buttons (typed answers aside).
  const buttons: [string, string][] = [
    ...(ANSWERS[q.type] ?? (kind === 'yes_no' ? ['yes', 'no'] : [])).map((a): [string, string] => [a, answerText(q, a)]),
    ...(q.type === 'tentacles' ? candidatesOf(q).map((c): [string, string] => [c.feature_id, c.name]) : []),
    ...(nullLabel ? [[NULL_ANSWER, nullLabel] as [string, string]] : []),
  ]
  const typed = kind === 'text' || kind === 'number'
  const typedAnswer = typed && text.trim() && (kind === 'text' || /^\d{1,4}$/.test(text.trim())) ? text.trim() : null
  const answer = choice ?? typedAnswer

  useEffect(
    () => () => {
      if (photo) URL.revokeObjectURL(photo.url)
    },
    [photo],
  )

  const pickPhoto = async (file: File | undefined) => {
    if (!file) return
    setErr(null)
    setBusy('Preparing photo…')
    try {
      const blob = await shrinkPhoto(file)
      setPhoto({ blob, url: URL.createObjectURL(blob), path: photoPath(sync.gameId, q.id) })
      setChoice(null)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(null)
    }
  }

  const overlay = useMemo(
    () => ({
      tool: questionTool(q, layer),
      ruled,
      zone: zone.bar ? { lng: zone.bar.point[0], lat: zone.bar.point[1], radiusM: zone.bar.radiusM, team: 'hiders' as const } : null,
      dots: [
        ...seekers,
        ...(zone.gps ? [{ id: 'me', lng: zone.gps.point[0], lat: zone.gps.point[1], team: 'hiders' as const, me: true }] : []),
      ],
    }),
    [q, layer, ruled, zone, seekers],
  )

  const send = async () => {
    setErr(null)
    try {
      let a = answer
      if (!a && photo && supabase) {
        setBusy('Uploading photo…')
        a = await uploadPhoto(supabase, photo.path, photo.blob)
      }
      if (!a) return
      setBusy('Sending…')
      await sync.action('answer_question', { p_question_id: q.id, p_answer: a })
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(null)
    }
  }
  const playPowerup = async (instanceId: string) => {
    setErr(null)
    setBusy('Playing…')
    try {
      await sync.action('play_card', { p_instance_id: instanceId })
    } catch (e) {
      setErr(describeError(e))
      setBusy(null)
    }
  }
  const ready = answer !== null || photo !== null
  const draw = Math.round(q.reward.draw * rewardMultiplier)
  const pick = Math.round(q.reward.pick * rewardMultiplier)
  const sendLabel =
    busy ?? (answer ? `Send “${answerText(q, answer)}”` : photo ? 'Send photo' : typed ? 'Type an answer' : 'Pick an answer')
  const ref = q.params

  return (
    <section className="card answer-sheet" aria-live="polite">
      <div className="sheet-head">
        <div>
          <p className="eyebrow">New question · from {askerName}</p>
          <h2>{questionLabel(q)}</h2>
          <p className="muted">{questionText(q)}</p>
          {q.type === 'matching' && typeof ref.name === 'string' && (
            <p className="ref-note">
              Their nearest {(optionText(q) ?? '').toLowerCase()}: <strong>{ref.name}</strong>
            </p>
          )}
          {q.type === 'measuring' && typeof ref.distance_m === 'number' && (
            <p className="ref-note">
              They are <strong>{km(ref.distance_m)}</strong> from {optionText(q)}.
            </p>
          )}
          {q.type === 'tentacles' && typeof ref.radius_m === 'number' && (
            <p className="ref-note">
              {candidatesOf(q).length
                ? `${candidatesOf(q).length} within ${km(ref.radius_m)} of them.`
                : `Nothing of this kind within ${km(ref.radius_m)} of them.`}
            </p>
          )}
        </div>
        <DeadlineRing endsAt={shownEnd(q.deadlineAt, q.pausedLeftMs, now)} totalS={q.deadlineS} now={now} />
      </div>

      {(isLngLat(q.params.center) || isLngLat(q.params.start)) && (
        <Suspense fallback={<div className="game-map mini-map" />}>
          <LazyGameMap city={city} playArea={playArea} className="mini-map" overlay={overlay} tapNames={false} venues={venues} />
        </Suspense>
      )}

      <div className="suggestion">
        <PrivateLabel />
        {suggestion ? (
          <>
            <p>
              Suggested: <strong>{answerText(q, suggestion.answer)}</strong>{' '}
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
          <p className="muted">
            {q.type === 'photos' || (q.type === 'bonus' && !q.params.count)
              ? 'No suggestion for this one: answer it yourself.'
              : 'No suggestion: lock in a bar or allow location.'}
          </p>
        )}
      </div>

      <div className={`answer-buttons${buttons.length > 2 ? ' answer-list' : ''}`}>
        {buttons.map(([a, label]) => (
          <button
            key={a}
            className={`answer${choice === a ? ' on' : ''}`}
            aria-pressed={choice === a}
            disabled={!!busy || !canAct}
            onClick={() => {
              setChoice(choice === a ? null : a)
              setPhoto(null)
            }}
          >
            {label}
            {suggestion?.answer === a && <span className="suggested-tag">Suggested</span>}
          </button>
        ))}
      </div>
      {typed && (
        <input
          className="answer-input"
          inputMode={kind === 'number' ? 'numeric' : 'text'}
          maxLength={200}
          value={text}
          aria-label="Your answer"
          placeholder={kind === 'number' ? 'A number' : 'Your answer'}
          onChange={(e) => {
            setText(e.target.value)
            setChoice(null)
          }}
        />
      )}
      {q.type === 'photos' && (
        <div className="photo-answer">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            hidden
            onChange={(e) => void pickPhoto(e.target.files?.[0])}
          />
          {photo && <img className="photo-preview" src={photo.url} alt="Your photo" />}
          <button className="secondary wide" disabled={!!busy || !canAct} onClick={() => fileRef.current?.click()}>
            {photo ? 'Retake photo' : 'Take photo'}
          </button>
        </div>
      )}
      <button className="wide" disabled={!ready || !!busy || !canAct} onClick={() => void send()}>
        {sendLabel}
      </button>
      {late && <p className="flag">Deadline passed: a shot for your team is logged. You still need to answer.</p>}
      <p className="muted small">
        Answering earns you: draw {draw}, keep {pick}
        {rewardMultiplier !== 1 ? ` (×${+rewardMultiplier.toFixed(2)})` : ''}.
      </p>
      {powerups.length > 0 && (
        <div className="sheet-powerups">
          <p className="eyebrow">
            <LockIcon /> Or play a card instead
          </p>
          <div className="confirm-row">
            {[...new Map(powerups.map((p) => [p.action, p])).values()].map((p) => (
              <button key={p.instanceId} className="secondary" disabled={!!busy || !canAct} onClick={() => void playPowerup(p.instanceId)}>
                {p.name}
              </button>
            ))}
          </div>
          <p className="muted small">Veto: no answer, no reward. Randomize: they get another question of this type.</p>
        </div>
      )}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
