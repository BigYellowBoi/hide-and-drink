import { useState } from 'react'
import {
  canSayNotApplicable,
  clearable,
  notApplicable,
  DRINK_BUCKET,
  effectPhase,
  effectTimer,
  evidenceFor,
  hiderProofKind,
  hiderProofPrompt,
  judgeOf,
  proofPrompt,
  liveEffects,
  proofDone,
  proofKind,
  setupFor,
  otherBlocks,
  questionsBlockedBy,
  triviaTodo,
  type CardsState,
  type DrinkProof,
  type Effect,
} from '../cards/state'
import { formatClock } from '../hiding/state'
import { timerTone } from '../lib/timers'
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
      <OtherBlockedBanners cards={cards} team={team} />
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

export function BlockedBanner({
  effects,
  team,
  what = 'questions',
  onOpen,
}: {
  effects: readonly Effect[]
  team: Team
  what?: string
  /** Opens the Effects tab, where the seekers send their proof or say they did it. */
  onOpen?: () => void
}) {
  return (
    <div className="blocked-banner" role="status">
      <strong>{what.charAt(0).toUpperCase() + what.slice(1)} blocked</strong>
      <p>
        {team === 'seekers' ? 'Until you complete ' : 'Seekers must complete '}
        {effects.map((e) => e.card.name).join(' and ')}.
      </p>
      {onOpen && (
        <button className="small" onClick={onOpen}>
          Open
        </button>
      )}
    </div>
  )
}

/** One yellow banner per thing curses block besides questions (params.blocks, e.g. transport). */
export function OtherBlockedBanners({ cards, team, onOpen }: { cards: CardsState; team: Team; onOpen?: () => void }) {
  return (
    <>
      {otherBlocks(cards).map(([what, effects]) => (
        <BlockedBanner key={what} what={what} effects={effects} team={team} onOpen={onOpen} />
      ))}
    </>
  )
}

function EffectCard({ sync, cards, effect: e, team, canAct, now, config, nameOf }: Props & { effect: Effect }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const phase = effectPhase(e, now)
  const timer = effectTimer(e, now)
  const played = cards.played.find((p) => p.effectId === e.id)
  const evidence = evidenceFor(cards, e.id)
  const setup = setupFor(cards, e.id)
  const setupMedia = hiderProofKind(e.card) ?? 'photo'
  // The hiders' first step (e.g. Unguided Tourist's screenshot): the seekers wait for it.
  const waitingForHiders = !!setup && !proofDone(setup)

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
      {phase === 'awaiting_seekers' &&
        (team === 'seekers' ? (
          <CurseCheck sync={sync} effect={e} canAct={canAct} />
        ) : (
          <span className="muted small">Waiting for the seekers to say if it applies: “{e.seekerConfirm}”</span>
        ))}
      {timer && <EffectBar endsAt={timer[0]} totalS={timer[1]} now={now} label={phase === 'followup' ? 'Locked' : 'Left'} />}
      {team === 'seekers' && canSayNotApplicable(e, now) && <NotApplicable sync={sync} effect={e} canAct={canAct} />}
      {phase === 'followup_available' && (
        <span className="effect-actions">
          <span className="muted small">Time's up. Missed it?</span>
          <button className="secondary small" disabled={busy || !canAct} onClick={() => void act('start_followup', {})}>
            Start {minutes(e.followupS)} lock
          </button>
        </span>
      )}
      {setup &&
        (waitingForHiders ? (
          <span className="muted small">
            {team === 'hiders'
              ? `Send the seekers your ${setupMedia} (pinned on top of your screen).`
              : `Waiting for the hiders' ${setupMedia}. You can send yours once it arrives.`}
          </span>
        ) : (
          setup.path && (
            <span className="effect-actions">
              <span className="muted small">{team === 'hiders' ? `Your ${setupMedia}:` : `The hiders' ${setupMedia}:`}</span>
              <PhotoThumb path={setup.path} bucket={DRINK_BUCKET} alt={`The hiders' ${setupMedia}`} />
            </span>
          )
        ))}
      {clearable(e, now) &&
        !waitingForHiders &&
        (team === 'seekers' ? (
          evidence && !evidence.path && !evidence.resolution ? (
            <EvidenceClear
              sync={sync}
              proof={evidence}
              prompt={proofPrompt(e.card)}
              media={proofKind(e.card) ?? 'photo'}
              canAct={canAct && !busy}
              onSent={() => act('clear_effect', {})}
            />
          ) : (
            <button className="small" disabled={busy || !canAct} onClick={() => void act('clear_effect', {})}>
              We did it
            </button>
          )
        ) : (
          <span className="muted small">
            Waiting for the seekers to do it{evidence ? ` and send a ${proofKind(e.card) ?? 'photo'}` : ''}.
          </span>
        ))}
      {e.behaviour === 'trivia' && <TriviaBox sync={sync} effect={e} team={team} canAct={canAct} nameOf={nameOf} />}
      {evidence?.path && phase === 'awaiting_confirm' && <PhotoThumb path={evidence.path} bucket={DRINK_BUCKET} alt="Seekers' proof" />}
      {phase === 'awaiting_confirm' && (
        <span className="muted small">{team === 'seekers' ? 'Waiting for the hider to confirm.' : 'Seekers say they did it. Confirm above.'}</span>
      )}
      {played && <CardUtility sync={sync} cards={cards} instanceId={played.instanceId} card={e.card} canAct={canAct} nameOf={nameOf} />}
      {played && team === 'seekers' && <VetoButton sync={sync} cards={cards} played={played} config={config} canAct={canAct} now={now} />}
      {err && <span className="bad small">{err}</span>}
    </CardFace>
  )
}

/** Seekers: a curse with photo or video proof is cleared by sending it, then "we did it". */
function EvidenceClear({
  sync,
  proof,
  prompt,
  media,
  canAct,
  onSent,
}: {
  sync: GameSync
  proof: DrinkProof
  prompt: string | null
  media: 'photo' | 'video'
  canAct: boolean
  onSent: () => Promise<void>
}) {
  const { box, photo, busy, err, send } = useProofPhoto(sync, proof.id, media, !canAct)
  return (
    <span className="effect-actions">
      <span className="muted small">
        {prompt ? `${prompt} ` : ''}
        {media === 'video' ? 'Video' : 'Photo'} proof needed: the hider sees it before confirming.
      </span>
      {box}
      <button
        className="small"
        disabled={!photo || !!busy || !canAct}
        onClick={() => void send().then((ok) => (ok ? onSent() : undefined))}
      >
        {busy ?? 'Send, we did it'}
      </button>
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/**
 * Hiders: the first step of a curse with params.hider_proof (Unguided Tourist's Street View
 * screenshot, Bird Guide's video), pinned on every tab until it is sent. The seekers can't
 * say they did it before it arrives.
 */
export function SetupProofs({ sync, cards, canAct }: { sync: GameSync; cards: CardsState; canAct: boolean }) {
  const open = cards.proofs.filter(
    (p) =>
      p.kind === 'setup' &&
      !proofDone(p) &&
      cards.effects.some((e) => e.id === p.effectId && (e.status === 'active' || e.status === 'clear_requested')),
  )
  return (
    <>
      {open.map((p) => {
        const effect = cards.effects.find((e) => e.id === p.effectId)!
        return <SetupProofCard key={p.id} sync={sync} proof={p} effect={effect} canAct={canAct} />
      })}
    </>
  )
}

function SetupProofCard({ sync, proof, effect, canAct }: { sync: GameSync; proof: DrinkProof; effect: Effect; canAct: boolean }) {
  const media = hiderProofKind(effect.card) ?? 'photo'
  const prompt = hiderProofPrompt(effect.card)
  const { box, photo, busy, err, send } = useProofPhoto(sync, proof.id, media, !canAct)
  return (
    <section className="card drink-proof" role="alert">
      <p className="eyebrow">Send the seekers your {media}</p>
      <h2>{effect.card.name}</h2>
      {prompt ? <p>{prompt}</p> : effect.card.text && <p className="muted small">{effect.card.text}</p>}
      {box}
      <button className="wide" disabled={!photo || !!busy || !canAct} onClick={() => void send()}>
        {busy ?? 'Send to the seekers'}
      </button>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}

/** Thin bar for a running curse (docs/design.md). */
export function EffectBar({ endsAt, totalS, now, label }: { endsAt: number; totalS: number; now: number; label: string }) {
  const left = Math.max(0, endsAt - now)
  const frac = totalS > 0 ? Math.min(1, left / (totalS * 1000)) : 0
  return (
    <span className={`effect-bar effect-bar-${timerTone(left)}`} role="timer" aria-label={`${label} ${formatClock(left)}`}>
      <span className="effect-bar-track">
        <span className="effect-bar-fill" style={{ width: `${frac * 100}%` }} />
      </span>
      <span className="effect-bar-time">{left > 0 ? `${label} ${formatClock(left)}` : "Time's up"}</span>
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
                    : e.trivia.lastFailed
                      ? `Trivia: ${e.trivia.lastFailed.right ? `only ${e.trivia.lastFailed.right}` : 'none'} right, waiting for new questions`
                      : 'Trivia: waiting for the questions'
                  : effectPhase(e, now) === 'awaiting_seekers'
                  ? 'Waiting for the seekers to confirm'
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

/**
 * Seekers: a curse with params.seeker_confirm (e.g. Prison, only if they're in the hiders'
 * bar) waits for them to say whether it applies. Yes starts it, no drops it.
 */
export function CurseCheck({ sync, effect: e, canAct }: { sync: GameSync; effect: Effect; canAct: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const answer = async (applies: boolean) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('check_curse', { p_effect_id: e.id, p_applies: applies })
    } catch (x) {
      setErr(describeError(x))
      setBusy(false)
    }
  }
  return (
    <span className="effect-actions">
      <span className="small">
        <strong>{e.seekerConfirm}</strong> Be honest: the hiders see your answer.
      </span>
      <span className="confirm-row">
        <button className="secondary small" disabled={busy || !canAct} onClick={() => void answer(false)}>
          No, doesn't apply
        </button>
        <button className="small" disabled={busy || !canAct} onClick={() => void answer(true)}>
          Yes, it applies
        </button>
      </span>
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/** Seekers: cancel a running curse that doesn't apply to them (params.not_applicable, e.g. Escape). */
export function NotApplicable({ sync, effect: e, canAct }: { sync: GameSync; effect: Effect; canAct: boolean }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const cancel = async () => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('check_curse', { p_effect_id: e.id, p_applies: false })
    } catch (x) {
      setErr(describeError(x))
      setBusy(false)
    }
  }
  return (
    <span className="effect-actions">
      <span className="muted small">{notApplicable(e.card)} Be honest: the hiders see it.</span>
      <button className="secondary small" disabled={busy || !canAct} onClick={() => void cancel()}>
        Not applicable
      </button>
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/** Seekers: curses waiting for them to say whether they apply, pinned on top of the other tabs. */
export function CurseCheckPrompt({ sync, cards, canAct }: { sync: GameSync; cards: CardsState; canAct: boolean }) {
  const waiting = cards.effects.filter((e) => e.status === 'awaiting_seekers')
  if (!waiting.length) return null
  return (
    <>
      {waiting.map((e) => (
        <section key={e.id} className="card confirm-clear" role="alert">
          <p className="eyebrow">Curse: does it apply?</p>
          <h2>{e.card.name}</h2>
          {e.card.text && <p className="muted small">{e.card.text}</p>}
          <CurseCheck sync={sync} effect={e} canAct={canAct} />
        </section>
      ))}
    </>
  )
}

/** Hider: seekers say they've done a curse. Pinned on top until confirmed or rejected. */
export function ConfirmClear({
  sync,
  effect: e,
  canAct,
  proofPath = null,
  setupPath = null,
}: {
  sync: GameSync
  effect: Effect
  canAct: boolean
  /** The seekers' photo or video, for a curse with proof. */
  proofPath?: string | null
  /** The hiders' own first step (params.hider_proof), to compare against. */
  setupPath?: string | null
}) {
  const judge = judgeOf(e.card)
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
      <p className="eyebrow">{judge.question ? 'Seekers sent theirs' : 'Seekers say they did it'}</p>
      <h2>{e.card.name}</h2>
      {judge.question ? <p>{judge.question}</p> : e.card.text && <p className="muted small">{e.card.text}</p>}
      {setupPath && proofPath ? (
        <div className="proof-compare">
          <figure>
            <figcaption className="eyebrow">Yours</figcaption>
            <PhotoThumb path={setupPath} bucket={DRINK_BUCKET} alt="Your proof" />
          </figure>
          <figure>
            <figcaption className="eyebrow">Seekers'</figcaption>
            <PhotoThumb path={proofPath} bucket={DRINK_BUCKET} alt="Seekers' proof" />
          </figure>
        </div>
      ) : (
        proofPath && <PhotoThumb path={proofPath} bucket={DRINK_BUCKET} alt="Seekers' proof" />
      )}
      <div className="confirm-row">
        <button className="secondary" disabled={busy || !canAct} onClick={() => void answer(false)}>
          {judge.reject}
        </button>
        <button disabled={busy || !canAct} onClick={() => void answer(true)}>
          {judge.accept}
        </button>
      </div>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
