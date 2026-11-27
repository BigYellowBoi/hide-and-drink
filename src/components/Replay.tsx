import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { SyncTransport } from '../sync/transport'
import { describeError } from '../lobby/messages'
import { clockLabel } from '../hiding/state'
import { questionTool } from '../play/overlays'
import { useQuestionTypes } from '../play/useQuestionTypes'
import type { Question } from '../play/state'
import { deriveRounds, formatDuration, names } from '../rounds/state'
import { fetchReplay, type ReplayData } from '../replay/api'
import { buildReplay, moveAt, roundAt, shadableAt, stepAt, trackAt, type Replay as ReplayModel, type ReplayRound, type ReplayStep } from '../replay/state'
import { LazyGameMap } from './lazyMap'
import { TimelineItemView } from './Timeline'
import { PrivateWordContext } from './hiderCount'
import { DownloadButton } from './PastGames'
import type { SavedGame } from '../replay/saved'
import { MediaSourceContext, zipMediaSource } from '../replay/mediaSource'
import type { CityPack } from '../map/cityPack'
import type { QuestionType } from '../play/questionTypes'
import type { FeatureCollection } from 'geojson'
import { deriveLobby } from '../lobby/state'
import { hidingZone } from '../hiding/state'
import { shadingBounds } from '../play/features'
import { moveConstraint, shade } from '../play/shading'
import { useCityLayers } from '../play/useCityLayers'

const PLAY_EVERY_MS = 2500

/**
 * After a game: a map with everyone's path over time and every event in order, revealed one
 * at a time (Next), or by dragging the scrubber. Both teams see everything here, hider-only
 * events and the hiders' paths included.
 */
export function Replay({ transport, gameId, onBack }: { transport: SyncTransport; gameId: string; onBack: () => void }) {
  const [data, setData] = useState<ReplayData | null>(null)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => {
    if (!supabase) return
    const client = supabase
    let live = true
    transport
      .signIn()
      .then(() => fetchReplay(client, gameId))
      .then((d) => live && setData(d))
      .catch((e: unknown) => live && setErr(describeError(e)))
    return () => {
      live = false
    }
  }, [transport, gameId])

  return (
    <>
      <header className="settings-bar">
        <button className="small secondary" onClick={onBack}>
          Back
        </button>
        <h1 className="settings-title">Replay</h1>
        {data ? <DownloadButton gameId={gameId} data={data} small /> : <span />}
      </header>
      {err && <p className="bad">{err}</p>}
      {!data && !err && <p className="muted">Loading replay…</p>}
      {data && <ReplayView data={data} />}
    </>
  )
}

/** A downloaded game opened from its zip (Home > Open a saved game): no server needed. */
export function SavedReplay({ saved, onBack }: { saved: SavedGame; onBack: () => void }) {
  const source = useMemo(() => zipMediaSource(saved.media), [saved.media])
  useEffect(() => () => source.revoke(), [source])
  return (
    <>
      <header className="settings-bar">
        <button className="small secondary" onClick={onBack}>
          Back
        </button>
        <h1 className="settings-title">Saved game</h1>
        <span />
      </header>
      <MediaSourceContext.Provider value={source.get}>
        <ReplayView data={saved.data} cityPack={saved.pack} savedTypes={saved.types} />
      </MediaSourceContext.Provider>
    </>
  )
}

function ReplayView({
  data,
  cityPack = null,
  savedTypes = null,
}: {
  data: ReplayData
  /** Saved game: the map data and question types from its zip. */
  cityPack?: CityPack | null
  savedTypes?: QuestionType[] | null
}) {
  const replay = useMemo(() => buildReplay(data.events), [data.events])
  const names_ = useMemo(() => new Map(data.players.map((p) => [p.user_id, p.name])), [data.players])
  const nameOf = useCallback((id: string | null) => (id ? (names_.get(id) ?? 'Player') : 'Someone'), [names_])
  const [idx, setIdx] = useState(-1)
  const [t, setT] = useState(replay.start)
  const [playing, setPlaying] = useState(false)
  const [shown, setShown] = useState<Question | null>(null)
  const steps = replay.steps

  const go = (i: number) => {
    const n = Math.max(-1, Math.min(steps.length - 1, i))
    setIdx(n)
    setT(n >= 0 ? steps[n].at : replay.start)
    setShown(null)
  }
  const goRef = useRef(go)
  useEffect(() => {
    goRef.current = go
  })
  // Play: the next reveal every few seconds, until the last one.
  const auto = playing && idx < steps.length - 1
  useEffect(() => {
    if (!auto) return
    const timer = setTimeout(() => goRef.current(idx + 1), PLAY_EVERY_MS)
    return () => clearTimeout(timer)
  }, [auto, idx])

  const round = roundAt(replay, t)
  const city = data.game.city
  const serverTypes = useQuestionTypes(city)
  const types = savedTypes ?? serverTypes
  // The seekers' shading as it stood at this point of the round.
  const lobbyNow = useMemo(() => (round ? deriveLobby(round.events) : null), [round])
  const layer = useCityLayers(city, lobbyNow?.venues, cityPack)
  const playArea = round?.started.playArea ?? null
  const barRadiusM = lobbyNow ? hidingZone(lobbyNow.config).barRadiusM : 0
  // Everything before the next reveal: a question's step shows its answer's shading too.
  const cutSeq = idx >= 0 ? (steps[idx + 1]?.seq ?? Infinity) - 1 : (round?.fromSeq ?? 0)
  const answered = useMemo(() => (round ? shadableAt(round, cutSeq) : []), [round, cutSeq])
  const move = useMemo(() => (round ? moveAt(round, cutSeq) : null), [round, cutSeq])
  const shading = useMemo(() => {
    const keep = moveConstraint(move, barRadiusM)
    if (!playArea || (!answered.length && !keep)) return null
    const ctx = layer ? { layer, bounds: shadingBounds(playArea), barRadiusM } : undefined
    return shade(playArea, answered, ctx, keep ? [keep] : [])
  }, [playArea, answered, layer, barRadiusM, move])
  const track = useMemo(() => (round ? trackAt(data.track, round.round, t, nameOf) : { paths: [], dots: [] }), [data.track, round, t, nameOf])
  const overlay = useMemo(
    () => ({
      paths: track.paths,
      dots: track.dots,
      zone: round?.bar ? { lng: round.bar.lng, lat: round.bar.lat, radiusM: round.bar.radiusM, team: 'hiders' as const } : null,
      tool: shown ? questionTool(shown, layer ?? undefined) : undefined,
      ruled: shading?.ruledOut,
      remaining:
        shading?.remaining && shading.ruledOut.features.length
          ? ({ type: 'FeatureCollection', features: [shading.remaining] } as FeatureCollection)
          : undefined,
    }),
    [track, round, shown, shading, layer],
  )
  const current = idx >= 0 ? steps[idx] : null
  const earlier = steps.slice(0, Math.max(0, idx)).reverse()
  const clockFor = (r: ReplayRound | null) => (at: number) => (r ? clockLabel(at, r.started.startedAt, r.started.hidingPeriodS, r.started.pauses) : '')

  return (
    <PrivateWordContext.Provider value="hiders only">
      <section className="card replay-head">
        <p className="eyebrow">
          {new Date(replay.start).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' })}
          {round?.started.playAreaName ? ` · ${round.started.playAreaName}` : ''}
        </p>
        <h2>{round ? `Round ${round.round}` : 'Game'}</h2>
        {round && (
          <p className="muted small">
            Hiders {names(round.hiders.map((id) => ({ userId: id, name: nameOf(id) })))}
            {round.bar ? ` at ${round.bar.name}` : ''}
          </p>
        )}
      </section>

      <Suspense fallback={<div className="game-map replay-map" />}>
        <LazyGameMap city={city} playArea={round?.started.playArea ?? null} className="replay-map" overlay={overlay} hideVenues cityPack={cityPack} />
      </Suspense>

      <section className="card replay-controls">
        <label className="replay-scrub">
          <span className="sr-only">Time</span>
          <input
            type="range"
            min={replay.start}
            max={Math.max(replay.end, replay.start + 1)}
            step={1000}
            value={t}
            onChange={(e) => {
              const v = Number(e.target.value)
              setPlaying(false)
              setT(v)
              setIdx(stepAt(steps, v))
              setShown(null)
            }}
          />
          <span className="replay-clock">{round ? clockFor(round)(t) : ''}</span>
        </label>
        <div className="row replay-buttons">
          <button className="secondary" disabled={idx < 0} onClick={() => (setPlaying(false), go(idx - 1))}>
            Previous
          </button>
          <button className="secondary" disabled={idx >= steps.length - 1} onClick={() => setPlaying(!auto)}>
            {auto ? 'Pause' : 'Play'}
          </button>
          <button disabled={idx >= steps.length - 1} onClick={() => (setPlaying(false), go(idx + 1))}>
            {idx < 0 ? 'Start' : 'Next'}
          </button>
        </div>
        <p className="muted small replay-count">
          {idx < 0 ? `${steps.length} moments to reveal` : `${idx + 1} of ${steps.length}`}
        </p>
      </section>

      {current && (
        <ol className="timeline replay-spotlight" aria-live="polite">
          <StepView step={current} replay={replay} data={data} types={types} nameOf={nameOf} clockFor={clockFor} onShow={setShown} />
        </ol>
      )}
      {earlier.length > 0 && (
        <section className="card">
          <h2>Earlier</h2>
          <ol className="timeline">
            {earlier.map((s) => (
              <StepView
                key={`${s.kind}${s.seq}`}
                step={s}
                replay={replay}
                data={data}
                types={types}
                nameOf={nameOf}
                clockFor={clockFor}
                onShow={(q) => {
                  setShown(q)
                  window.scrollTo({ top: 0, behavior: 'smooth' })
                }}
              />
            ))}
          </ol>
        </section>
      )}
    </PrivateWordContext.Provider>
  )
}

function StepView({
  step,
  replay,
  data,
  types,
  nameOf,
  clockFor,
  onShow,
}: {
  step: ReplayStep
  replay: ReplayModel
  data: ReplayData
  types: ReturnType<typeof useQuestionTypes>
  nameOf: (id: string | null) => string
  clockFor: (r: ReplayRound | null) => (at: number) => string
  onShow: (q: Question) => void
}) {
  const r = replay.rounds.find((x) => x.round === step.round) ?? null
  if (step.kind === 'round') {
    const seekers = data.players.filter((p) => r && !r.hiders.includes(p.user_id))
    return (
      <li className="tl-row replay-round">
        <span className="log-dot" aria-hidden="true" />
        <span>
          <strong>Round {step.round} starts.</strong> {names((r?.hiders ?? []).map((id) => ({ userId: id, name: nameOf(id) })))} hide
          {r?.bar ? ` at ${r.bar.name}` : ''}; {names(seekers.map((p) => ({ userId: p.user_id, name: p.name })))} seek.
        </span>
      </li>
    )
  }
  if (step.kind === 'end') {
    const result = deriveRounds(replay.events)
    const winners = result.result?.winners ?? []
    const best = result.rounds.filter((x) => !x.voided)
    const total = (id: string) => best.filter((x) => x.hiders.some((h) => h.userId === id)).reduce((n, x) => n + x.totalS, 0)
    return (
      <li className="tl-row replay-round">
        <span className="log-dot" aria-hidden="true" />
        <span>
          <strong>Game over.</strong>{' '}
          {winners.length
            ? `${names(winners.map((id) => ({ userId: id, name: nameOf(id) })))} ${winners.length > 1 ? 'win' : 'wins'} with ${formatDuration(total(winners[0]))}.`
            : 'No winner.'}
        </span>
      </li>
    )
  }
  if (!r) return null
  return (
    <TimelineItemView
      it={step.item}
      log={r.log}
      cards={r.cards}
      now={replay.end}
      types={types}
      clock={clockFor(r)}
      nameOf={nameOf}
      onShow={onShow}
    />
  )
}
