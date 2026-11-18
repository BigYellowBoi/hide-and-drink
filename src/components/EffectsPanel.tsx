import { useState } from 'react'
import { effectPhase, effectTimer, liveEffects, questionsBlockedBy, type CardsState, type Effect } from '../cards/state'
import { formatClock } from '../hiding/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'
import { CardFace } from './CardFace'

interface Props {
  sync: GameSync
  cards: CardsState
  team: Team
  canAct: boolean
  now: number
}

const minutes = (s: number | null) => (s ? `${Math.round(s / 60)} min` : '')

/** Cards in play: blocked banner, curses with timers or We did it, then what's been played. */
export function EffectsPanel({ sync, cards, team, canAct, now }: Props) {
  const live = liveEffects(cards, now)
  const blocked = questionsBlockedBy(cards)
  const others = [...cards.played].filter((p) => !p.effectId).reverse()
  return (
    <>
      {blocked.length > 0 && <BlockedBanner effects={blocked} team={team} />}
      <section className="card">
        <h2>In play</h2>
        {live.length === 0 ? (
          <p className="muted">No curses running.</p>
        ) : (
          <div className="effect-list">
            {live.map((e) => (
              <EffectCard key={e.id} sync={sync} effect={e} team={team} canAct={canAct} now={now} />
            ))}
          </div>
        )}
      </section>
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

function EffectCard({ sync, effect: e, team, canAct, now }: Omit<Props, 'cards'> & { effect: Effect }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const phase = effectPhase(e, now)
  const timer = effectTimer(e, now)

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
      {phase === 'until_cleared' &&
        (team === 'seekers' ? (
          <button className="small" disabled={busy || !canAct} onClick={() => void act('clear_effect', {})}>
            We did it
          </button>
        ) : (
          <span className="muted small">Waiting for the seekers to do it.</span>
        ))}
      {phase === 'awaiting_confirm' && (
        <span className="muted small">{team === 'seekers' ? 'Waiting for the hider to confirm.' : 'Seekers say they did it. Confirm above.'}</span>
      )}
      {err && <span className="bad small">{err}</span>}
    </CardFace>
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
                {effectPhase(e, now) === 'followup_available'
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

/** Hider: seekers say they've done a curse. Pinned on top until confirmed or rejected. */
export function ConfirmClear({ sync, effect: e, canAct }: { sync: GameSync; effect: Effect; canAct: boolean }) {
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
