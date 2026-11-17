import { Suspense, useEffect, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import { supabase } from '../lib/supabase'
import { readLocal, writeLocal } from '../lib/storage'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { describeError } from '../lobby/messages'
import { distanceM, isLngLat, type LngLat } from '../play/geo'
import { measuringTool, radarTool, thermometerTool } from '../play/overlays'
import { loadQuestionTypes, optionLabel, type QuestionType } from '../play/questionTypes'
import { isSupportedType, km, MAP_TYPES, questionText, typeName } from '../play/state'
import { radarCircle } from '../play/geo'
import type { Fix, GeoError } from '../hiding/useGeolocation'
import { formatClock } from '../hiding/state'
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
  /** Why questions are blocked (a curse in play), or null. */
  blocked?: string | null
  now: number
  /** This phone's GPS (the seeker view already watches it and shares it with the team). */
  fix: Fix | null
  geoError: GeoError | null
}

const startKey = (gameId: string) => `hd.thermometer.${gameId}`

/** Seekers: pick a question type and option, place the tool, send. */
export function AskPanel({ sync, gameId, city, playArea, ruled, canAct, seekingAt, pending, blocked = null, now, fix, geoError }: Props) {
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
  const gpsPoint: LngLat | null = fix ? [fix.lng, fix.lat] : null
  const here: LngLat | null = tapped ?? gpsPoint
  const distance =
    option && typeof option.distance_m === 'number'
      ? option.distance_m
      : option
        ? Math.round(parseFloat(customKm) * 1000) || null
        : null
  const travelled = start && here ? distanceM(start, here) : 0
  const hidingLeft = seekingAt === null ? 0 : seekingAt - now

  const fixLng = fix?.lng
  const fixLat = fix?.lat
  const overlay = useMemo(() => {
    const at: LngLat | null = tapped ?? (fixLng !== undefined && fixLat !== undefined ? [fixLng, fixLat] : null)
    let tool: FeatureCollection | undefined
    const target = isLngLat(option?.point) ? option.point : null
    const radius = typeof option?.radius_m === 'number' ? option.radius_m : null
    if (type === 'radar' && at && distance) tool = radarTool(at, distance)
    else if (type === 'thermometer' && start) tool = thermometerTool(start, at)
    else if (type === 'measuring' && target) tool = measuringTool(target, at ? distanceM(at, target) : 1, at)
    else if (type === 'tentacles' && at && radius) tool = { type: 'FeatureCollection', features: [radarCircle(at, radius)] }
    const dots =
      fixLng !== undefined && fixLat !== undefined
        ? [{ id: 'me', lng: fixLng, lat: fixLat, team: 'seekers' as const, me: true }]
        : []
    return { ruled, tool, dots }
    // `distance` comes from the loaded option list, which is never mutated.
    // oxlint-disable-next-line react/preserve-manual-memoization
  }, [type, tapped, fixLng, fixLat, distance, start, ruled, option])

  let blocker: string | null = null
  if (!qt || !isSupportedType(type)) blocker = 'Pick a question type.'
  else if (!option) blocker = 'Pick an option.'
  else if ((type === 'radar' || type === 'thermometer') && (!distance || distance < 10)) blocker = 'Type a distance.'
  else if ((MAP_TYPES.includes(type) || type === 'thermometer') && !here)
    blocker = 'Waiting for GPS. Or tap the map to place yourself.'
  else if (type === 'thermometer' && !start) blocker = 'Mark where you start, then travel.'
  else if (type === 'thermometer' && distance && travelled < distance) blocker = `Travel ${km(distance - travelled)} more.`
  if (hidingLeft > 0) blocker = `Questions open when hiding ends (${formatClock(hidingLeft)}).`
  else if (pending) blocker = 'Waiting for the answer to the last question.'
  else if (blocked) blocker = blocked

  const send = async () => {
    if (blocker || !option) return
    setBusy(true)
    setErr(null)
    try {
      const params =
        type === 'radar'
          ? { center: here, ...(option.distance_m == null ? { distance_m: distance } : {}) }
          : type === 'thermometer'
            ? { start, end: here }
            : MAP_TYPES.includes(type)
              ? { center: here }
              : {}
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
              <strong>{typeName(t.type)}</strong>
              <span className="small">{ok ? `Draw ${t.reward_draw}, keep ${t.reward_pick}` : 'Soon'}</span>
            </button>
          )
        })}
        {!types && <p className="muted">Loading questions…</p>}
      </div>

      {qt && (
        <>
          <p className={option ? 'question-preview' : 'muted'}>
            {option && type !== 'radar' && type !== 'thermometer'
              ? questionText({ type, prompt: qt.prompt, params: { label: optionLabel(option) } })
              : qt.prompt}
          </p>
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

      {(MAP_TYPES.includes(type) || type === 'thermometer') && (
        <>
      <Suspense fallback={<div className="game-map ask-map" />}>
        <LazyGameMap city={city} playArea={playArea} className="ask-map" overlay={overlay} onTap={setTapped} tapNames={false} />
      </Suspense>
      <p className="muted small">
        {tapped ? (
          <>
            Using the point you tapped.{' '}
            <button className="link" onClick={() => setTapped(null)}>
              Use GPS
            </button>
          </>
        ) : fix ? (
          `Using GPS${fix.accuracyM !== null ? ` (±${Math.round(fix.accuracyM)} m)` : ''}. Tap the map to place it by hand.`
        ) : (
          `${geoError === 'denied' ? 'Location is blocked.' : 'Waiting for GPS.'} Tap the map to place yourself.`
        )}
      </p>

        </>
      )}
      {option && MAP_TYPES.includes(type) && type !== 'radar' && (
        <p className="muted small">Sends where you are with the question.</p>
      )}

      <button className="wide" disabled={!!blocker || busy || !canAct} onClick={() => void send()}>
        {sent ? 'Sent' : 'Send question'}
      </button>
      {blocker && <p className="muted small">{blocker}</p>}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
