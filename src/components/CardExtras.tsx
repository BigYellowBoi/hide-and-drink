import { useState } from 'react'
import {
  cardUtility,
  lockedUntil,
  nextVetoLockS,
  openProofs,
  vetoable,
  vetoLock,
  type CardDef,
  type CardsState,
  type DrinkProof,
  type PlayedCard,
} from '../cards/state'
import { formatClock } from '../hiding/state'
import { describeError } from '../lobby/messages'
import type { GameSync } from '../sync/engine'
import type { Team } from '../sync/types'
import { EffectBar } from './EffectsPanel'
import { useProofPhoto } from './useProofPhoto'

const minutes = (s: number) => `${Math.round(s / 60)} min`

/** Run one action with busy/error state. */
function useAction(sync: GameSync) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const run = async (fn: string, params: Record<string, unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action(fn, params)
      return true
    } catch (e) {
      setErr(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }
  return { busy, err, run }
}

/** Dice or wheel for a played card: server random, so every phone sees the same roll. */
export function CardUtility({
  sync,
  cards,
  instanceId,
  card,
  canAct,
  nameOf,
}: {
  sync: GameSync
  cards: CardsState
  instanceId: string
  card: CardDef
  canAct: boolean
  nameOf: (userId: string | null) => string
}) {
  const { busy, err, run } = useAction(sync)
  const u = cardUtility(card)
  if (!u) return null
  const last = [...cards.rolls].reverse().find((r) => r.instanceId === instanceId)
  return (
    <span className="utility">
      {u.kind === 'dice' ? (
        <button className="secondary small" disabled={busy || !canAct} onClick={() => void run('roll_dice', { p_instance_id: instanceId })}>
          Roll {u.dice > 1 ? `${u.dice} dice` : 'the die'}
        </button>
      ) : u.options.length ? (
        <button className="secondary small" disabled={busy || !canAct} onClick={() => void run('spin_wheel', { p_instance_id: instanceId })}>
          Spin the wheel
        </button>
      ) : u.url ? (
        <a className="link-button" href={u.url} target="_blank" rel="noreferrer">
          Open the wheel
        </a>
      ) : null}
      {last && (
        <span className="utility-result" key={last.seq} aria-live="polite">
          {last.kind === 'dice' ? (
            <>
              {last.dice.map((d, i) => (
                <span key={i} className="die" aria-label={`Die ${d}`}>
                  {d}
                </span>
              ))}
              {last.dice.length > 1 && <strong> = {last.total}</strong>}
            </>
          ) : (
            <strong className="wheel-result">{last.result}</strong>
          )}
          <span className="muted small"> {nameOf(last.by)}</span>
        </span>
      )}
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/** Seekers: veto a curse. Shows the lock it will cost. */
export function VetoButton({
  sync,
  cards,
  played,
  config,
  canAct,
  now,
}: {
  sync: GameSync
  cards: CardsState
  played: PlayedCard
  config: Record<string, unknown>
  canAct: boolean
  now: number
}) {
  const { busy, err, run } = useAction(sync)
  const [sure, setSure] = useState(false)
  if (!vetoable(cards, played, now)) return null
  const lock = nextVetoLockS(cards, config)
  return (
    <span className="effect-actions">
      {sure ? (
        <>
          <span className="small">
            Locked at a bar for {minutes(lock)}
            {lockedUntil(cards, now) ? ' (after your current lock)' : ''} and each seeker drinks.
          </span>
          <span className="confirm-row">
            <button className="secondary small" disabled={busy} onClick={() => setSure(false)}>
              Keep it
            </button>
            <button
              className="small"
              disabled={busy || !canAct}
              onClick={() => void run('veto_curse', { p_instance_id: played.instanceId }).then(() => setSure(false))}
            >
              Veto
            </button>
          </span>
        </>
      ) : (
        <button className="secondary small" disabled={!canAct} onClick={() => setSure(true)}>
          Veto ({minutes(lock)} lock)
        </button>
      )}
      {err && <span className="bad small">{err}</span>}
    </span>
  )
}

/** Seekers locked at a bar after a veto (both teams see it). */
export function LockBanner({ cards, team, now }: { cards: CardsState; team: Team; now: number }) {
  const v = vetoLock(cards, now)
  const until = lockedUntil(cards, now)
  if (!v || !until) return null
  const started = now >= v.lockStartsAt
  return (
    <div className="blocked-banner" role="status">
      <strong>{team === 'seekers' ? 'Locked at a bar' : 'Seekers locked at a bar'}</strong>
      <p>
        Veto of {v.name}.{' '}
        {started ? `${formatClock(until - now)} left${v.pausedLeftMs !== null ? ' (paused by the host)' : ''}.` : `Next lock starts in ${formatClock(v.lockStartsAt - now)}.`}
      </p>
      {started && <EffectBar endsAt={v.pausedLeftMs !== null ? now + v.pausedLeftMs : v.lockEndsAt} totalS={v.lockS} now={now} label="Left" />}
    </div>
  )
}

/** Vetoes used this run and what the next one costs. */
export function VetoSummary({ cards, config }: { cards: CardsState; config: Record<string, unknown> }) {
  return (
    <p className="muted small">
      Vetoes used: {cards.vetoes.length}. Next veto: {minutes(nextVetoLockS(cards, config))} locked at a bar.
    </p>
  )
}

/** Questions banned for the run. */
export function BanList({ cards }: { cards: CardsState }) {
  if (!cards.bans.length) return null
  return (
    <section className="card">
      <h2>Banned questions</h2>
      <ul className="played-list">
        {cards.bans.map((b) => (
          <li key={`${b.type}:${b.optionId}`}>
            <span className="log-dot" style={{ background: 'var(--brand-red)' }} aria-hidden="true" />
            <span>
              <strong>{b.label}</strong> <span className="muted small">({b.type}, rest of the run)</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

/**
 * Photo proof for drinks the app knows about: pinned on top for the team that owes it until
 * a photo is sent. The other team sees the photo in the log.
 */
export function DrinkProofs({ sync, cards, team, canAct }: { sync: GameSync; cards: CardsState; team: Team; canAct: boolean }) {
  const open = openProofs(cards, team)
  if (!open.length) return null
  return (
    <>
      {open.map((p) => (
        <DrinkProofCard key={p.id} sync={sync} proof={p} canAct={canAct} />
      ))}
    </>
  )
}

function DrinkProofCard({ sync, proof, canAct }: { sync: GameSync; proof: DrinkProof; canAct: boolean }) {
  const { box, busy, err, photo, send } = useProofPhoto(sync, proof.id, 'photo', !canAct)
  return (
    <section className="card drink-proof" role="alert">
      <p className="eyebrow">Photo proof</p>
      <h2>{proof.cost === 'shot' ? 'Take a shot' : 'Have a drink'}</h2>
      <p className="muted small">{proof.label}. Photograph it: the other team sees the photo.</p>
      {box}
      <button className="wide" disabled={!photo || !!busy || !canAct} onClick={() => void send()}>
        {busy ?? 'Send'}
      </button>
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
