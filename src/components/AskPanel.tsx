import { Suspense, useEffect, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import { supabase } from '../lib/supabase'
import { readLocal, writeLocal } from '../lib/storage'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { describeError } from '../lobby/messages'
import { distanceM, isLngLat, type LngLat } from '../play/geo'
import { meOverlay, radarTool, thermometerTool } from '../play/overlays'
import { loadQuestionTypes, optionLabel, type QuestionType } from '../play/questionTypes'
import { isSupportedType, km } from '../play/state'
import { usePosition } from '../play/usePosition'
import { mmss } from '../play/useServerNow'
import { LazyGameMap } from './lazyMap'

interface Props {
  sync: GameSync
  gameId: string
  city: string
  playArea: AreaCollection | null
  ruled: FeatureCollection
  canAct: boolean
  /** Server ms when questions open; null if unknown. */
  seekingAt: number | null
  pending: boolean
  now: number
}

const NAMES: Record<string, string> = {
  matching: 'Matching',
  measuring: 'Measuring',
  thermometer: 'Thermometer',
  radar: 'Radar',
  tentacles: 'Tentacles',
  photos: 'Photo',
  bonus: 'Bonus',
}

const startKey = (gameId: string) => `hd.thermometer.${gameId}`

/** Seekers: pick a question type and option, place the tool, send. */
export function AskPanel({ sync, gameId, city, playArea, ruled, canAct, seekingAt, pending, now }: Props) {
  const [types, setTypes] = useState<QuestionType[] | null>(null)
  const [type, setType] = useState<string>('radar')
  const [optionId, setOptionId] = useState<string | null>(null)
  const [customKm, setCustomKm] = useState('')
  /** A point tapped on the map overrides GPS (no fix, or testing indoors). */
  const [tapped, setTapped] = useState<LngLat | null>(null)
  const [start, setStart] = useState<LngLat | null>(() => {
    try {
      const v: unknown = JSON.parse(readLocal(startKey(gameId)) ?? 'null')
      return isLngLat(v) ? v : null
    } catch {
      return null
    }
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const { position, error: gpsError } = usePosition()

  useEffect(() => {
    if (!supabase) return
    loadQuestionTypes(supabase, city)
      .then(setTypes)
      .catch((e: unknown) => setErr(describeError(e)))
  }, [city])

  const saveStart = (p: LngLat | null) => {
    setStart(p)
    writeLocal(startKey(gameId), p ? JSON.stringify(p) : null)
  }

  const qt = types?.find((t) => t.type === type) ?? null
  const option = qt?.options.find((o) => o.id === optionId) ?? null
  const here: LngLat | null = tapped ?? position?.point ?? null
  const distance =
    option && typeof option.distance_m === 'number'
      ? option.distance_m
      : option
        ? Math.round(parseFloat(customKm) * 1000) || null
        : null
  const travelled = start && here ? distanceM(start, here) : 0
  const hidingLeft = seekingAt === null ? 0 : seekingAt - now

  const gpsPoint = position?.point ?? null
  const overlays = useMemo(() => {
    const at = tapped ?? gpsPoint
    let tool: FeatureCollection | undefined
    if (type === 'radar' && at && distance) tool = radarTool(at, distance)
    else if (type === 'thermometer' && start) tool = thermometerTool(start, at)
    return { ruled, tool, me: meOverlay(gpsPoint, '#FF6B6F') }
    // `distance` comes from the loaded option list, which is never mutated.
    // oxlint-disable-next-line react/preserve-manual-memoization
  }, [type, tapped, gpsPoint, distance, start, ruled])

  let blocker: string | null = null
  if (!qt || !isSupportedType(type)) blocker = 'Pick a question type.'
  else if (!option) blocker = 'Pick an option.'
  else if (!distance || distance < 10) blocker = 'Type a distance.'
  else if (!here) blocker = 'Waiting for GPS. Or tap the map to place yourself.'
  else if (type === 'thermometer' && !start) blocker = 'Mark where you start, then travel.'
  else if (type === 'thermometer' && travelled < distance) blocker = `Travel ${km(distance - travelled)} more.`
  if (hidingLeft > 0) blocker = `Questions open when hiding ends (${mmss(hidingLeft)}).`
  else if (pending) blocker = 'Waiting for the answer to the last question.'

  const send = async () => {
    if (blocker || !here || !option) return
    setBusy(true)
    setErr(null)
    try {
      const params =
        type === 'radar'
          ? { center: here, ...(option.distance_m == null ? { distance_m: distance } : {}) }
          : { start, end: here }
      await sync.action('ask_question', { p_type: type, p_option_id: option.id, p_params: params })
      if (type === 'thermometer') saveStart(null)
      setSent(true)
      setTimeout(() => setSent(false), 3000)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card ask">
      <div className="type-tiles" role="radiogroup" aria-label="Question type">
        {(types ?? []).map((t) => {
          const ok = isSupportedType(t.type)
          return (
            <button
              key={t.type}
              role="radio"
              aria-checked={type === t.type}
              className={`type-tile${type === t.type ? ' on' : ''}`}
              disabled={!ok}
              onClick={() => {
                setType(t.type)
                setOptionId(null)
              }}
            >
              <strong>{NAMES[t.type] ?? t.type}</strong>
              <span className="small">{ok ? `Draw ${t.reward_draw}, keep ${t.reward_pick}` : 'Soon'}</span>
            </button>
          )
        })}
        {!types && <p className="muted">Loading questions…</p>}
      </div>

      {qt && (
        <>
          <p className="muted">{qt.prompt}</p>
          <div className="chips" role="radiogroup" aria-label="Option">
            {qt.options.map((o) => (
              <button
                key={o.id}
                role="radio"
                aria-checked={optionId === o.id}
                className={`option-chip${optionId === o.id ? ' on' : ''}`}
                onClick={() => setOptionId(o.id)}
              >
                {optionLabel(o)}
              </button>
            ))}
          </div>
          {option && option.distance_m == null && type === 'radar' && (
            <label className="field">
              <span>Distance (km)</span>
              <input
                inputMode="decimal"
                value={customKm}
                placeholder="e.g. 1.5"
                onChange={(e) => setCustomKm(e.target.value.replace(',', '.'))}
              />
            </label>
          )}
        </>
      )}

      {type === 'thermometer' && (
        <div className="thermo">
          {start ? (
            <p>
              Travelled <strong>{km(travelled)}</strong>
              {distance ? ` of ${km(distance)}` : ''}
            </p>
          ) : (
            <p className="muted">Mark your start, travel the distance, then send from where you end up.</p>
          )}
          <div className="row">
            <button className="secondary small" disabled={!here} onClick={() => saveStart(here)}>
              {start ? 'Restart here' : 'Mark start here'}
            </button>
            {start && (
              <button className="secondary small" onClick={() => saveStart(null)}>
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      <Suspense fallback={<div className="game-map ask-map" />}>
        <LazyGameMap city={city} playArea={playArea} className="ask-map" overlays={overlays} onTap={setTapped} tapNames={false} />
      </Suspense>
      <p className="muted small">
        {tapped ? (
          <>
            Using the point you tapped.{' '}
            <button className="link" onClick={() => setTapped(null)}>
              Use GPS
            </button>
          </>
        ) : position ? (
          `Using GPS (±${Math.round(position.accuracyM)} m). Tap the map to place it by hand.`
        ) : (
          `${gpsError ?? 'Waiting for GPS.'} Tap the map to place yourself.`
        )}
      </p>

      <button className="wide" disabled={!!blocker || busy || !canAct} onClick={() => void send()}>
        {sent ? 'Sent' : 'Send question'}
      </button>
      {blocker && <p className="muted small">{blocker}</p>}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
