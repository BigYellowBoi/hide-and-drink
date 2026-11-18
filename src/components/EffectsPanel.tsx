import { useState } from 'react'
import {
  clearable,
  DRINK_BUCKET,
  effectPhase,
  effectTimer,
  evidenceFor,
  liveEffects,
  questionsBlockedBy,
  triviaTodo,
  type CardsState,
  type DrinkProof,
  type Effect,
} from '../cards/state'
import { formatClock } from '../hiding/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'
import { CardFace } from './CardFace'
import { BanList, CardUtility, LockBanner, VetoButton, VetoSummary } from './CardExtras'
import { useProofPhoto } from './useProofPhoto'
import { PhotoThumb } from './PhotoThumb'
import { TriviaBox } from './TriviaBox'

interface Props {
  sync: GameSync
  cards: CardsState
  team: Team
  canAct: boolean
  now: number
  /** Game config (veto lock lengths). */
  config: Record<string, unknown>
  nameOf: (userId: string | null) => string
  /** The host can mark a trivia curse all correct by hand. */
  isHost?: boolean
}

const minutes = (s: number | null) => (s ? `${Math.round(s / 60)} min` : '')

/** Cards in play: blocked banner, curses with timers or We did it, then what's been played. */
export function EffectsPanel(props: Props) {
  const { sync, cards, team, canAct, now, config, nameOf } = props
  const live = liveEffects(cards, now)
  const blocked = questionsBlockedBy(cards)
  const others = [...cards.played].filter((p) => !p.effectId).reverse()
  return (
    <>
      {blocked.length > 0 && <BlockedBanner effects={blocked} team={team} />}
      <LockBanner cards={cards} team={team} now={now} />
      {cards.moving && (
        <div className="blocked-banner" role="status">
          <strong>Hider is moving</strong>
          <p>Questions wait until they lock in a new bar.</p>
        </div>
      )}
      <section className="card">
        <h2>In play</h2>
        {live.length === 0 ? (
          <p className="muted">No curses running.</p>
        ) : (
          <div className="effect-list">
            {live.map((e) => (
              <EffectCard key={e.id} {...props} effect={e} />
            ))}
          </div>
        )}
        <VetoSummary cards={cards} config={config} />
      </section>
      <BanList cards={cards} />
      {others.length > 0 && (
        <section className="card">
          <h2>Played this round</h2>
          <ul className="played-list">
            {others.map((p) => (
              <li key={p.seq}>
                <span className="log-dot" style={{ background: p.card.colour }} aria-hidden="true" />
                <span>
                  <strong>{p.card.name}</strong>
                  {p.card.text ? `: ${p.card.text}` : ''}
                  {cards.vetoes.some((v) => v.instanceId === p.instanceId) && <span className="penalty"> · vetoed</span>}
                  <CardUtility sync={sync} cards={cards} instanceId={p.instanceId} card={p.card} canAct={canAct} nameOf={nameOf} />
                  {team === 'seekers' && <VetoButton sync={sync} cards={cards} played={p} config={config} canAct={canAct} now={now} />}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

export function BlockedBanner({ effects, team }: { effects: readonly Effect[]; team: Team }) {
  return (
    <div className="blocked-banner" role="status">
      <strong>Questions blocked</strong>
      <p>
        {team === 'seekers' ? 'Until you complete ' : 'Seekers must complete '}
        {effects.map((e) => e.card.name).join(' and ')}.
      </p>
    </div>
  )
}

function EffectCard({ sync, cards, effect: e, team, canAct, now, config, nameOf, isHost = false }: Props & { effect: Effect }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const phase = effectPhase(e, now)
  const timer = effectTimer(e, now)
  const played = cards.played.find((p) => p.effectId === e.id)
  const evidence = evidenceFor(cards, e.id)

  const act = async (fn: string, params: Record<string, unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action(fn, { p_effect_id: e.id, ...params })
    } catch (x) {
      setErr(describeError(x))
    } finally {
      setBusy(false)
    }
  }

  return (
    <CardFace card={e.card}>
      {timer && <EffectBar endsAt={timer[0]} totalS={timer[1]} now={now} label={phase === 'followup' ? 'Locked' : 'Left'} />}
      {phase === 'followup_available' && (
        <span className="effect-actions">
          <span className="muted small">Time's up. Missed it?</span>
          <button className="secondary small" disabled={busy || !canAct} onClick={() => void act('start_followup', {})}>
            Start {minutes(e.followupS)} lock
          </button>
        </span>
      )}
      {clearable(e, now) &&
        (team === 'seekers' ? (
          evidence && !evidence.path ? (
            <EvidenceClear sync={sync} proof={evidence} canAct={canAct && !busy} onSent={() => act('clear_effect', {})} />
          ) : (
            <button className="small" disabled={busy || !canAct} onClick={() => void act('clear_effect', {})}>
              We did it
            </button>
          )
        ) : (
          <span className="muted small">
            Waiting for the seekers to do it{evidence ? ' and send a photo' : ''}.
          </span>
        ))}
      {e.behaviour === 'trivia' && <TriviaBox sync={sync} effect={e} team={team} canAct={canAct} isHost={isHost} nameOf={nameOf} />}
      {evidence?.path && phase === 'awaiting_confirm' && <PhotoThumb path={evidence.path} bucket={DRINK_BUCKET} alt="Proof photo" />}
      {phase === 'awaiting_confirm' && (
        <span className="muted small">{team === 'seekers' ? 'Waiting for the hider to confirm.' : 'Seekers say they did it. Confirm above.'}</span>
      )}
      {played && <CardUtility sync={sync} cards={cards} instanceId={played.instanceId} card={e.card} canAct={canAct} nameOf={nameOf} />}
      {played && team === 'seekers' && <VetoButton sync={sync} cards={cards} played={played} config={config} canAct={canAct} now={now} />}
      {err && <span className="bad small">{err}</span>}
    </CardFace>
  )
}

/** Seekers: a curse with photo proof is cleared by sending the photo, then "we did it". */
function EvidenceClear({ sync, proof, canAct, onSent }: { sync: GameSync; proof: DrinkProof; canAct: boolean; onSent: () => Promise<void> }) {
  const { input, photo, busy, err, take, send } = useProofPhoto(sync, proof.id)
  return (
    <span className="effect-actions">
      {input}
      <span className="muted small">Photo proof needed: the hider sees it before confirming.</span>
      {photo && <img className="photo-preview" src={photo.url} alt="Your proof" />}
      <span className="confirm-row">
        <button className="secondary small" disabled={!!busy || !canAct} onClick={take}>
          {photo ? 'Retake' : 'Take photo'}
        </button>
        <button
          className="small"
          disabled={!photo || !!busy || !canAct}
          onClick={() => void send().then((ok) => (ok ? onSent() : undefined))}
        >
          {busy ?? 'Send, we did it'}
        </button>
      </span>
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/** Thin bar for a running curse (docs/design.md). */
export function EffectBar({ endsAt, totalS, now, label }: { endsAt: number; totalS: number; now: number; label: string }) {
  const left = Math.max(0, endsAt - now)
  const frac = totalS > 0 ? Math.min(1, left / (totalS * 1000)) : 0
  return (
    <span className="effect-bar">
      <span className="effect-bar-track">
        <span className="effect-bar-fill" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="effect-bar-time">
        {label} {formatClock(left)}
      </span>
    </span>
  )
}

/** Compact strip of running curses for the map tab. */
export function EffectStrip({ cards, now }: { cards: CardsState; now: number }) {
  const live = liveEffects(cards, now)
  if (!live.length) return null
  return (
    <ul className="effect-strip" aria-label="Curses in play">
      {live.map((e) => {
        const t = effectTimer(e, now)
        return (
          <li key={e.id} style={{ borderColor: e.card.colour }}>
            <strong>{e.card.name}</strong>
            {t ? (
              <EffectBar endsAt={t[0]} totalS={t[1]} now={now} label={effectPhase(e, now) === 'followup' ? 'Locked' : 'Left'} />
            ) : (
              <span className="muted small">
                {e.trivia
                  ? e.trivia.questions
                    ? `Trivia: ${e.trivia.questions.filter((q) => q.correct).length} of ${e.trivia.questions.length} right`
                    : 'Trivia: waiting for the questions'
                  : effectPhase(e, now) === 'followup_available'
                  ? "Time's up. Missed it? See Effects"
                  : effectPhase(e, now) === 'awaiting_confirm'
                    ? 'Waiting for the hider'
                    : e.blocksQuestions
                      ? 'Blocks questions'
                      : 'Until done'}
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/** A trivia curse waiting on this team, pinned on top of the other tabs. */
export function TriviaPrompt({ effects, team, onOpen }: { effects: readonly Effect[]; team: Team; onOpen: () => void }) {
  const e = effects[0]
  if (!e?.trivia) return null
  const todo = triviaTodo(e, team)
  const open = e.trivia.questions?.filter((q) => !q.correct).length ?? 0
  const title =
    todo === 'write'
      ? `Write ${e.trivia.count} trivia questions`
      : todo === 'mark'
        ? `Mark ${open} trivia answer${open > 1 ? 's' : ''}`
        : `Answer ${open} trivia question${open > 1 ? 's' : ''}`
  return (
    <section className="card pick-prompt confirm-clear" role="status">
      <div>
        <p className="eyebrow">{e.card.name}</p>
        <h2>{title}</h2>
      </div>
      <button className="small" onClick={onOpen}>
        Open
      </button>
    </section>
  )
}

/** Hider: seekers say they've done a curse. Pinned on top until confirmed or rejected. */
export function ConfirmClear({
  sync,
  effect: e,
  canAct,
  proofPath = null,
}: {
  sync: GameSync
  effect: Effect
  canAct: boolean
  /** The seekers' photo, for a curse with photo proof. */
  proofPath?: string | null
}) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const answer = async (accept: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('confirm_clear', { p_effect_id: e.id, p_accept: accept })
    } catch (x) {
      setErr(describeError(x))
      setBusy(false)
    }
  }
  return (
    <section className="card confirm-clear" role="alert">
      <p className="eyebrow">Seekers say they did it</p>
      <h2>{e.card.name}</h2>
      {e.card.text && <p className="muted small">{e.card.text}</p>}
      {proofPath && <PhotoThumb path={proofPath} bucket={DRINK_BUCKET} alt="Proof photo" />}
      <div className="confirm-row">
        <button className="secondary" disabled={busy || !canAct} onClick={() => void answer(false)}>
          Not yet
        </button>
        <button disabled={busy || !canAct} onClick={() => void answer(true)}>
          Confirm
        </button>
      </div>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
