import { useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GameSync } from '../sync/engine'
import type { LobbyState } from '../lobby/state'
import { describeError } from '../lobby/messages'
import type { PlayState } from '../play/state'
import { outcomeText, questionLabel } from '../play/state'
import type { CardsState } from '../cards/state'
import { cardOf } from '../cards/state'
import type { LayerLookup } from '../play/features'
import { featureId } from '../play/features'
import type { Team } from '../sync/types'
import { usePosition } from '../hiding/usePosition'
import { isDevMode } from '../hiding/devPosition'
import { availableOverrides, needsHiderApproval, optionOf, type OverrideOption } from '../overrides/catalogue'
import type { OverrideRequest, OverridesState } from '../overrides/state'

interface Props {
  sync: GameSync
  lobby: LobbyState
  play: PlayState
  cards: CardsState
  overrides: OverridesState
  userId: string | null
  team: Team | null
  canAct: boolean
  layer: LayerLookup | null
  /** A seeker host's request this hider is carrying out. */
  request?: OverrideRequest | null
  onClose: () => void
}

type Params = Record<string, unknown>
type Opt = { value: string; label: string }

function Pick({ label, value, options, onChange }: { label: string; value: string; options: Opt[]; onChange: (v: string) => void }) {
  return (
    <label className="fix-field">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">{options.length ? 'Choose…' : 'Nothing to choose'}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  )
}

function Text({ label, value, onChange, max = 120 }: { label: string; value: string; onChange: (v: string) => void; max?: number }) {
  return (
    <label className="fix-field">
      <span>{label}</span>
      <input value={value} maxLength={max} onChange={(e) => onChange(e.target.value)} />
    </label>
  )
}

function Num({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min: number; max: number }) {
  return (
    <label className="fix-field">
      <span>{label}</span>
      <input type="number" inputMode="numeric" value={value} min={min} max={max} onChange={(e) => onChange(Number(e.target.value))} />
    </label>
  )
}

/**
 * The host's "Fix something" sheet: every automatic decision can be overridden by hand with a
 * short reason, through host_override. Hider-only fixes from a seeker host go to the hiders
 * as a request; a hider carrying one out opens this sheet with `request` set.
 */
export function FixSomething({ sync, lobby, play, cards, overrides, userId, team, canAct, layer, request, onClose }: Props) {
  const isHost = !!userId && userId === lobby.hostId
  const isHider = team === 'hiders'
  const options = useMemo(() => availableOverrides(isHost, isHider), [isHost, isHider])
  const [kind, setKind] = useState<string | null>(request?.kind ?? null)
  const [params, setParams] = useState<Params>(request?.params ?? {})
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const pos = usePosition(isDevMode(lobby.config), sync.gameId, userId)
  const option = kind ? optionOf(kind) : null
  const set = (k: string, v: unknown) => setParams((p) => ({ ...p, [k]: v }))

  const submit = async (send: Params) => {
    if (!option) return
    setBusy(true)
    setErr(null)
    try {
      const res = (await sync.action('host_override', {
        p_kind: option.kind,
        p_params: send,
        p_reason: request ? null : reason,
        p_request_id: request?.id ?? null,
      })) as { pending?: boolean } | null
      setDone(res?.pending ? 'Sent to the hiders: a hider does this one (you only see that it happened).' : 'Done. It shows in the timeline.')
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const decline = async () => {
    if (!request) return
    setBusy(true)
    try {
      await sync.action('host_override', { p_kind: 'decline', p_params: null, p_reason: null, p_request_id: request.id })
      onClose()
    } catch (e) {
      setErr(describeError(e))
      setBusy(false)
    }
  }

  const round = lobby.started?.round ?? 0
  const qs = play.questions.filter((q) => q.round === round)
  const qOpt = (filter: (q: (typeof qs)[number]) => boolean): Opt[] =>
    qs.filter(filter).map((q) => ({ value: q.id, label: `${questionLabel(q)} · ${outcomeText(q)}` }))
  const effects = cards.effects.map((e) => ({ value: e.id, label: `${e.card.name} (${e.status.replace('_', ' ')})`, e }))
  const proofs = cards.proofs
    .filter((p) => !p.path && !p.resolution)
    .map((p) => ({ value: p.id, label: `${p.team === 'hiders' ? 'Hiders' : 'Seekers'}: ${p.kind === 'evidence' ? 'photo for' : p.cost} ${p.label}` }))
  const players = lobby.players.map((p) => ({ value: p.userId, label: `${p.name} (${p.team ?? 'no team'})` }))

  const form = (o: OverrideOption) => {
    switch (o.kind) {
      case 'cancel_penalty':
        return <Pick label="Question" value={String(params.question_id ?? '')} options={qOpt((q) => q.overdue && !q.penaltyCancelled)} onChange={(v) => set('question_id', v)} />
      case 'add_penalty':
        return (
          <>
            <Pick label="Team" value={String(params.team ?? '')} options={[{ value: 'hiders', label: 'Hiders' }, { value: 'seekers', label: 'Seekers' }]} onChange={(v) => set('team', v)} />
            <Pick label="Drink" value={String(params.cost ?? 'shot')} options={[{ value: 'drink', label: 'Drink' }, { value: 'shot', label: 'Shot' }]} onChange={(v) => set('cost', v)} />
            <Text label="What for" value={String(params.label ?? '')} max={80} onChange={(v) => set('label', v)} />
          </>
        )
      case 'cancel_drink':
      case 'waive_proof':
        return <Pick label="Drink or photo" value={String(params.proof_id ?? '')} options={proofs} onChange={(v) => set('proof_id', v)} />
      case 'timer': {
        const timer = String(params.timer ?? '')
        const targets: Opt[] =
          timer === 'answer'
            ? qOpt((q) => q.answer === null && q.closedBy === null)
            : timer === 'effect'
              ? effects.filter((x) => x.e.endsAt !== null).map(({ value, label }) => ({ value, label }))
              : timer === 'followup'
                ? effects.filter((x) => x.e.followupEndsAt !== null).map(({ value, label }) => ({ value, label }))
                : timer === 'veto_lock'
                  ? cards.vetoes.map((v) => ({ value: v.instanceId, label: `Veto of ${v.name}` }))
                  : []
        return (
          <>
            <Pick
              label="Countdown"
              value={timer}
              options={[
                { value: 'hiding', label: 'Hiding period (start seeking early or late)' },
                { value: 'answer', label: 'Answer deadline' },
                { value: 'effect', label: 'Curse timer' },
                { value: 'followup', label: 'Curse follow-on timer' },
                { value: 'veto_lock', label: 'Veto lock' },
              ]}
              onChange={(v) => setParams({ timer: v, op: params.op ?? 'add', seconds: params.seconds ?? 300 })}
            />
            {timer && timer !== 'hiding' && <Pick label="Which" value={String(params.id ?? '')} options={targets} onChange={(v) => set('id', v)} />}
            <Pick
              label="Change"
              value={String(params.op ?? 'add')}
              options={[
                { value: 'add', label: 'Add or take away time' },
                { value: 'pause', label: 'Pause' },
                { value: 'resume', label: 'Resume' },
                { value: 'end', label: timer === 'hiding' ? 'End now (start seeking)' : 'End now' },
              ]}
              onChange={(v) => set('op', v)}
            />
            {(params.op ?? 'add') === 'add' && (
              <Num label="Minutes (negative takes time away)" value={Number(params.seconds ?? 300) / 60} min={-600} max={600} onChange={(v) => set('seconds', Math.round(v * 60))} />
            )}
          </>
        )
      }
      case 'freeze':
        return (
          <Pick
            label="Freeze alert"
            value={params.frozen === true ? 'on' : params.frozen === false ? 'off' : 'auto'}
            options={[
              { value: 'on', label: 'On (the hider must stay put)' },
              { value: 'off', label: 'Off' },
              { value: 'auto', label: 'Automatic (from seekers\' positions)' },
            ]}
            onChange={(v) => set('frozen', v === 'on' ? true : v === 'off' ? false : null)}
          />
        )
      case 'set_bar':
        return <BarFields params={params} setParams={setParams} layer={layer} pos={pos.fix ? [pos.fix.lng, pos.fix.lat] : null} />
      case 'set_answer':
        return (
          <>
            <Pick label="Question" value={String(params.question_id ?? '')} options={qOpt(() => true)} onChange={(v) => set('question_id', v)} />
            <Text label="Answer (as the hider would say it)" value={String(params.answer ?? '')} max={500} onChange={(v) => set('answer', v)} />
          </>
        )
      case 'void_answer':
        return <Pick label="Question" value={String(params.question_id ?? '')} options={qOpt((q) => q.closedBy !== 'void')} onChange={(v) => set('question_id', v)} />
      case 'reopen_question':
        return (
          <>
            <Pick label="Question" value={String(params.question_id ?? '')} options={qOpt((q) => q.answer !== null || q.closedBy !== null)} onChange={(v) => set('question_id', v)} />
            <Num label="Minutes to answer" value={Number(params.deadline_s ?? 300) / 60} min={1} max={120} onChange={(v) => set('deadline_s', Math.round(v * 60))} />
          </>
        )
      case 'ask_question':
        return (
          <>
            <Text label="Type (radar, thermometer, matching, measuring, tentacles, photos, bonus)" value={String(params.type ?? '')} onChange={(v) => set('type', v.trim().toLowerCase())} />
            <Text label="Option id (e.g. 1km)" value={String(params.option_id ?? '')} onChange={(v) => set('option_id', v.trim())} />
            <p className="muted small">Sent from your position{pos.fix ? '' : ' (no fix yet: it goes without map data)'}.</p>
          </>
        )
      case 'lift_ban':
        return (
          <Pick
            label="Ban"
            value={params.type ? `${params.type}:${params.option_id}` : ''}
            options={cards.bans.map((b) => ({ value: `${b.type}:${b.optionId}`, label: b.label }))}
            onChange={(v) => {
              const [type, ...rest] = v.split(':')
              setParams({ type, option_id: rest.join(':') })
            }}
          />
        )
      case 'set_blocking':
        return (
          <>
            <Pick label="Curse" value={String(params.effect_id ?? '')} options={effects} onChange={(v) => set('effect_id', v)} />
            <Pick label="Questions" value={params.blocks === true ? 'yes' : 'no'} options={[{ value: 'no', label: 'Not blocked' }, { value: 'yes', label: 'Blocked' }]} onChange={(v) => set('blocks', v === 'yes')} />
          </>
        )
      case 'clear_effect':
        return <Pick label="Curse" value={String(params.effect_id ?? '')} options={effects.filter((x) => x.e.status === 'active' || x.e.status === 'clear_requested')} onChange={(v) => set('effect_id', v)} />
      case 'reinstate_effect':
        return (
          <>
            <Pick label="Curse" value={String(params.effect_id ?? '')} options={effects.filter((x) => x.e.status !== 'active' || x.e.behaviour === 'timed')} onChange={(v) => set('effect_id', v)} />
            <Num label="Minutes (timed curses; 0 = the card's time)" value={Number(params.seconds ?? 0) / 60} min={0} max={600} onChange={(v) => set('seconds', Math.round(v * 60))} />
          </>
        )
      case 'cancel_veto':
        return <Pick label="Veto" value={String(params.instance_id ?? '')} options={cards.vetoes.map((v) => ({ value: v.instanceId, label: `Veto of ${v.name}` }))} onChange={(v) => set('instance_id', v)} />
      case 'set_hand_limit':
        return <Num label="Hand limit" value={Number(params.limit ?? cards.handLimit)} min={1} max={30} onChange={(v) => set('limit', v)} />
      case 'cancel_move':
      case 'reshuffle':
        return null
      case 'move_player':
        return (
          <>
            <Pick label="Player" value={String(params.user_id ?? '')} options={players} onChange={(v) => set('user_id', v)} />
            <Pick label="To" value={String(params.team ?? '')} options={[{ value: 'hiders', label: 'Hiders' }, { value: 'seekers', label: 'Seekers' }]} onChange={(v) => set('team', v)} />
          </>
        )
      case 'set_host':
        return <Pick label="New host" value={String(params.user_id ?? '')} options={players.filter((p) => p.value !== lobby.hostId)} onChange={(v) => set('user_id', v)} />
      case 'give_card':
        return (
          <Pick
            label="Card"
            value={String(params.card_id ?? '')}
            options={Object.values(cards.deck).map((c) => ({ value: c.id, label: `${c.name} (${c.categoryName})` }))}
            onChange={(v) => set('card_id', v)}
          />
        )
      case 'remove_card':
        return (
          <Pick label="Card" value={String(params.instance_id ?? '')} options={cards.hand.map((c) => ({ value: c.instanceId, label: cardOf(cards, c.cardId).name }))} onChange={(v) => set('instance_id', v)} />
        )
      case 'draw_cards':
        return (
          <>
            <Num label="Draw" value={Number(params.count ?? 1)} min={1} max={10} onChange={(v) => set('count', v)} />
            <Num label="Keep" value={Number(params.pick ?? 1)} min={1} max={10} onChange={(v) => set('pick', v)} />
          </>
        )
      case 'undo':
        return (
          <Pick
            label="Fix to undo"
            value={String(params.override_id ?? '')}
            options={overrides.overrides.filter((x) => !x.undone).map((x) => ({ value: x.id, label: x.detail ?? x.summary }))}
            onChange={(v) => set('override_id', v)}
          />
        )
    }
  }

  // ask_question sends this phone's position for the map data.
  const sendParams = option?.kind === 'ask_question' && pos.fix ? { ...params, params: { center: [pos.fix.lng, pos.fix.lat] } } : params
  const toHiders = option && !request && needsHiderApproval(option, isHider, params)

  return createPortal(
    <div className="info-backdrop" onClick={onClose}>
      <div className="info-sheet fix-sheet" role="dialog" aria-label="Fix something" onClick={(e) => e.stopPropagation()}>
        <div className="row fix-head">
          <h2>{request ? 'The host asks' : option ? option.label : 'Fix something'}</h2>
          <button className="small secondary" onClick={onClose}>
            Close
          </button>
        </div>
        {done ? (
          <>
            <p>{done}</p>
            <button className="wide" onClick={onClose}>
              OK
            </button>
          </>
        ) : !option ? (
          <>
            <p className="muted small">For when the app got something wrong. Everyone sees what you changed and why.</p>
            {(['Penalties and drinks', 'Timers', 'Bar and freeze', 'Questions', 'Cards', 'Players', 'Undo'] as const).map((g) => {
              const list = options.filter((o) => o.group === g)
              if (!list.length) return null
              return (
                <div key={g} className="fix-group">
                  <p className="eyebrow">{g}</p>
                  {list.map((o) => (
                    <button key={o.kind} className="fix-option" onClick={() => (setKind(o.kind), setParams({}))}>
                      <strong>{o.label}</strong>
                      <span className="muted small">
                        {o.line}
                        {o.private && !isHider ? ' A hider does it for you.' : ''}
                      </span>
                    </button>
                  ))}
                </div>
              )
            })}
          </>
        ) : (
          <>
            {request ? (
              <p>
                <strong>{option.label}</strong>: “{request.reason}”. {option.line}
              </p>
            ) : (
              <p className="muted small">{option.line}</p>
            )}
            <div className="fix-form">{toHiders && option.private ? null : form(option)}</div>
            {toHiders && (
              <p className="muted small">
                This touches what only the hiders know, so it goes to them: a hider picks the details and does it. You only see that it happened.
              </p>
            )}
            {!request && <Text label="Why (everyone sees this)" value={reason} onChange={setReason} />}
            {err && <p className="bad">{err}</p>}
            <div className="row">
              {request ? (
                <button className="secondary" disabled={busy || !canAct} onClick={() => void decline()}>
                  Decline
                </button>
              ) : (
                <button className="secondary" onClick={() => (setKind(null), setErr(null))}>
                  Back
                </button>
              )}
              <button
                disabled={busy || !canAct || (!request && !reason.trim())}
                onClick={() => void submit(toHiders && option.private ? {} : sendParams)}
              >
                {busy ? 'Saving…' : toHiders ? 'Ask the hiders' : 'Do it'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>,
    document.body,
  )
}

/** Pick any venue the app knows by name (even one it refuses), or pin an unlisted one here. */
function BarFields({
  params,
  setParams,
  layer,
  pos,
}: {
  params: Params
  setParams: (p: Params) => void
  layer: LayerLookup | null
  pos: [number, number] | null
}) {
  const [search, setSearch] = useState('')
  const pin = params.venue_id === undefined && params.name !== undefined
  const matches = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!layer || q.length < 2) return []
    return layer('venues')
      .filter((f) => String(f.properties?.name ?? '').toLowerCase().includes(q))
      .slice(0, 8)
      .map((f) => ({ id: featureId(f), name: String(f.properties?.name ?? '') }))
  }, [layer, search])
  return (
    <>
      <label className="fix-field">
        <span>Find a bar</span>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name" />
      </label>
      {matches.map((m) => (
        <button key={m.id} className={`fix-option${params.venue_id === m.id ? ' on' : ''}`} onClick={() => setParams({ venue_id: m.id })}>
          {m.name}
        </button>
      ))}
      <button
        className={`fix-option${pin ? ' on' : ''}`}
        disabled={!pos}
        onClick={() => pos && setParams({ name: search.trim() || 'Unlisted bar', lng: pos[0], lat: pos[1] })}
      >
        {pos ? `Pin “${search.trim() || 'Unlisted bar'}” where I am` : 'Pin where I am (waiting for GPS)'}
      </button>
    </>
  )
}
