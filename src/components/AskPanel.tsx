import { Suspense, useEffect, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import { supabase } from '../lib/supabase'
import { readLocal, writeLocal } from '../lib/storage'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { describeError } from '../lobby/messages'
import { distanceM, isLngLat, type LngLat } from '../play/geo'
import { measuringTool, nearestTool, radarTool, tentacleCandidates, tentaclesTool, thermometerTool } from '../play/overlays'
import type { LayerLookup } from '../play/features'
import { MapsLink } from './MapsLink'
import { loadQuestionTypes, optionLabel, textOn, typeColour, type QuestionOption, type QuestionType } from '../play/questionTypes'
import { isSupportedType, km, MAP_TYPES, questionText, typeName } from '../play/state'
import type { Fix, GeoError } from '../hiding/useGeolocation'
import { formatClock } from '../hiding/state'
import { banKey } from '../cards/state'
import { LazyGameMap } from './lazyMap'

interface Props {
  sync: GameSync
  gameId: string
  city: string
  playArea: AreaCollection | null
  ruled: FeatureCollection
  /** Where the hider can still be (white outline), as on the map tab. */
  remaining?: FeatureCollection
  /** Questions already asked this run, as banKey(type, option id): each is asked once. */
  used?: ReadonlySet<string>
  canAct: boolean
  /** Server ms when questions open; null if unknown. */
  seekingAt: number | null
  pending: boolean
  /** Why questions are blocked (a curse in play, the hider moving), or null. */
  blocked?: string | null
  /** Banned questions, as banKey(type, option id). */
  banned?: ReadonlySet<string>
  /** Seekers are serving a veto lock (asking is still allowed). */
  locked?: boolean
  now: number
  /** This phone's GPS (the seeker view already watches it and shares it with the team). */
  fix: Fix | null
  geoError: GeoError | null
  /** Dev/playtest mode: long-press the map to move this phone's position. */
  onLongPress?: (lngLat: [number, number]) => void
  /** City pack layers, to preview candidates (nearest library, ferry stops within 1 km). */
  layer?: LayerLookup | null
}

const startKey = (gameId: string) => `hd.thermometer.${gameId}`

/** Seekers: pick a question type and option, place the tool, send. */
const NONE: ReadonlySet<string> = new Set()

export function AskPanel({
  sync,
  gameId,
  city,
  playArea,
  ruled,
  remaining,
  used = NONE,
  canAct,
  seekingAt,
  pending,
  blocked = null,
  banned = NONE,
  locked = false,
  now,
  fix,
  geoError,
  onLongPress,
  layer = null,
}: Props) {
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

  const isUsed = (t: string, o: QuestionOption) => o.reusable !== true && used.has(banKey(t, o.id))
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
    const source = typeof option?.source === 'string' ? option.source : null
    if (type === 'radar' && at && distance) tool = radarTool(at, distance)
    else if (type === 'thermometer' && start) tool = thermometerTool(start, at)
    else if (type === 'measuring' && target)
      tool = measuringTool(target, at ? distanceM(at, target) : 1, at, option ? optionLabel(option) : undefined)
    else if (type === 'tentacles' && at && radius)
      tool = tentaclesTool(at, radius, layer && source ? tentacleCandidates(at, radius, layer(source)) : [])
    else if (type === 'matching' && at && layer && source) tool = nearestTool(at, layer(source))
    const dots =
      fixLng !== undefined && fixLat !== undefined
        ? [{ id: 'me', lng: fixLng, lat: fixLat, team: 'seekers' as const, me: true }]
        : []
    return { ruled, remaining, tool, dots }
    // `distance` comes from the loaded option list, which is never mutated.
    // oxlint-disable-next-line react/preserve-manual-memoization
  }, [type, tapped, fixLng, fixLat, distance, start, ruled, remaining, option, layer])

  let blocker: string | null = null
  if (!qt || !isSupportedType(type)) blocker = 'Pick a question type.'
  else if (!option) blocker = 'Pick an option.'
  else if (banned.has(banKey(type, option.id))) blocker = 'That question is banned for the rest of the run.'
  else if (isUsed(type, option)) blocker = 'Already asked this run: each question is asked once.'
  else if ((type === 'radar' || type === 'thermometer') && (!distance || distance < 10)) blocker = 'Type a distance.'
  else if ((MAP_TYPES.includes(type) || type === 'thermometer') && !here)
    blocker = onLongPress
      ? 'Long-press the map to set your position, or tap to place the tool.'
      : 'Waiting for GPS. Or tap the map to place yourself.'
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
      // Where this phone is (Plagued World keeps a no-question circle around it).
      const params = { ...(gpsPoint ? { here: gpsPoint } : {}), ...(
        type === 'radar'
          ? { center: here, ...(option.distance_m == null ? { distance_m: distance } : {}) }
          : type === 'thermometer'
            ? { start, end: here }
            : MAP_TYPES.includes(type)
              ? { center: here }
              : {}) }
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
          const colour = typeColour(types, t.type) ?? '#A9B4BF'
          const left = t.options.filter((o) => !isUsed(t.type, o) && !banned.has(banKey(t.type, o.id))).length
          return (
            <button
              key={t.type}
              role="radio"
              aria-checked={type === t.type}
              className={`pcard type-card${type === t.type ? ' pcard-on' : ''}${ok && left === 0 ? ' type-card-spent' : ''}`}
              disabled={!ok}
              onClick={() => {
                setType(t.type)
                setOptionId(null)
              }}
            >
              <span className="pcard-band" style={{ background: colour, color: textOn(colour) }}>
                {typeName(t.type)}
              </span>
              <span className="type-card-body">
                <span>{ok ? `Draw ${t.reward_draw}, keep ${t.reward_pick}` : 'Soon'}</span>
                {ok && <span className="muted">{left ? `${left} of ${t.options.length} left` : 'All asked'}</span>}
              </span>
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
            {qt.options.map((o) => {
              const isBanned = banned.has(banKey(type, o.id))
              const asked = isUsed(type, o)
              return (
                <button
                  key={o.id}
                  role="radio"
                  aria-checked={optionId === o.id}
                  className={`option-chip${optionId === o.id ? ' on' : ''}${isBanned || asked ? ' banned' : ''}`}
                  disabled={isBanned || asked}
                  title={isBanned ? 'Banned for the rest of the run' : asked ? 'Already asked this run' : undefined}
                  onClick={() => setOptionId(o.id)}
                >
                  {optionLabel(o)}
                </button>
              )
            })}
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
        <LazyGameMap city={city} playArea={playArea} className="ask-map" overlay={overlay} onTap={setTapped} onLongPress={onLongPress} tapNames={false} hideVenues />
      </Suspense>
      <p className="muted small">
        {tapped ? (
          <>
            Using the point you tapped.{' '}
            <button className="link" onClick={() => setTapped(null)}>
              {fix?.fake ? 'Use my position' : 'Use GPS'}
            </button>{' '}
            <MapsLink point={tapped} inline />
          </>
        ) : fix?.fake ? (
          'Using your playtest position (long-press the map to move it). Tap the map to place the tool by hand.'
        ) : fix ? (
          `Using GPS${fix.accuracyM !== null ? ` (±${Math.round(fix.accuracyM)} m)` : ''}. Tap the map to place it by hand.`
        ) : onLongPress ? (
          'Playtest mode: long-press the map to set your position, or tap to place the tool by hand.'
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
      {locked && !blocker && <p className="muted small">You're locked at a bar: ask from where you are.</p>}
      {err && <p className="bad">{err}</p>}
    </section>
  )
}
