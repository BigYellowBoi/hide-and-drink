import { useEffect, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import { supabase } from '../lib/supabase'
import type { GameSync } from '../sync/engine'
import type { Presence } from '../sync/presence'
import type { LobbyState } from '../lobby/state'
import { loadCityPack } from '../map/cityPack'
import { isLngLat } from '../play/geo'
import { circleOverlay, meOverlay, questionTool } from '../play/overlays'
import { remainingBars, shade, type HiderZone, type Venue } from '../play/shading'
import { answerLabel, questionLabel, shadable, type PlayState } from '../play/state'
import { usePosition } from '../play/usePosition'
import { useSettleTimers } from '../play/useSettleTimers'
import { mmss } from '../play/useServerNow'
import { AnswerSheet } from './AnswerSheet'
import { AskPanel } from './AskPanel'
import { BarPicker } from './BarPicker'
import { DeadlineRing } from './DeadlineRing'
import { GameMap } from './GameMap'
import { PlayLog } from './PlayLog'

type Tab = 'map' | 'ask' | 'questions' | 'log'
const TABS = {
  hiders: [
    ['map', 'Map'],
    ['questions', 'Questions'],
    ['log', 'Log'],
  ],
  seekers: [
    ['map', 'Map'],
    ['ask', 'Ask'],
    ['log', 'Log'],
  ],
} as const

interface Props {
  sync: GameSync
  lobby: LobbyState
  play: PlayState
  userId: string | null
  canAct: boolean
  presence: (userId: string) => Presence
  now: number
}

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }

function barRadius(config: Record<string, unknown>): number {
  const z = config.hiding_zone
  const r = typeof z === 'object' && z !== null ? (z as Record<string, unknown>).bar_radius_m : null
  return typeof r === 'number' && r > 0 ? r : 100
}

/** In-round screen: bottom tabs, map first; anything needing action pinned on top. */
export default function Play({ sync, lobby, play, userId, canAct, presence, now }: Props) {
  const team = lobby.players.find((p) => p.userId === userId)?.team ?? null
  const isHider = team === 'hiders'
  const [tab, setTab] = useState<Tab>('map')
  const [venues, setVenues] = useState<Venue[]>([])
  const [preview, setPreview] = useState<Venue | null>(null)
  const playArea = lobby.started?.playArea ?? null
  const radius = barRadius(lobby.config)
  // Hider GPS stays on the hider's phone (suggestions, own dot). Seekers' GPS runs in Ask.
  const { position } = usePosition(isHider)

  useSettleTimers(sync, play, canAct, now)

  useEffect(() => {
    if (!supabase) return
    let live = true
    loadCityPack(supabase, lobby.city)
      .then((pack) => {
        if (!live) return
        setVenues(
          pack.features
            .filter((f) => f.properties.layer === 'venues' && f.geometry.type === 'Point')
            .map((f) => ({
              id: String(f.id),
              name: f.properties.name,
              point: (f.geometry as GeoJSON.Point).coordinates as [number, number],
            }))
            .filter((v) => isLngLat(v.point)),
        )
      })
      .catch(() => {
        /* GameMap shows the load error */
      })
    return () => {
      live = false
    }
  }, [lobby.city])

  const answered = useMemo(() => shadable(play), [play])
  const shading = useMemo(() => (playArea ? shade(playArea, answered) : null), [playArea, answered])
  const inPlay = useMemo(
    () => (playArea ? remainingBars(venues, playArea, shade(playArea, []).remaining, 0) : []),
    [venues, playArea],
  )
  const left = useMemo(
    () => (playArea && shading ? remainingBars(venues, playArea, shading.remaining, radius) : []),
    [venues, playArea, shading, radius],
  )
  const ruled = shading?.ruledOut ?? EMPTY

  const zone: HiderZone = useMemo(
    () => ({
      bar: play.bar ? { point: play.bar.point, radiusM: radius } : null,
      gps: position ? { point: position.point, accuracyM: position.accuracyM } : null,
    }),
    [play.bar, radius, position],
  )

  const mapOverlays = useMemo(() => {
    const last = [...answered].reverse()[0]
    const barCircle = play.bar ?? preview
    return {
      ruled,
      zone: isHider && barCircle ? circleOverlay(barCircle.point, radius) : undefined,
      tool: play.pending ? questionTool(play.pending) : last ? questionTool(last) : undefined,
      me: isHider ? meOverlay(position?.point ?? null) : undefined,
    }
  }, [ruled, isHider, play.bar, preview, radius, play.pending, answered, position])

  const nameOf = (id: string | null) => lobby.players.find((p) => p.userId === id)?.name ?? 'a seeker'
  const pending = play.pending
  const hidingLeft = play.seekingAt !== null ? play.seekingAt - now : 0
  const tabs = team ? TABS[team] : TABS.seekers

  return (
    <>
      {/* One thing needs you at a time: the open question sits on top until handled. */}
      {pending && isHider && (
        <AnswerSheet
          key={pending.id}
          sync={sync}
          question={pending}
          askerName={nameOf(pending.askedBy)}
          city={lobby.city}
          playArea={playArea}
          zone={zone}
          ruled={ruled}
          canAct={canAct}
          now={now}
        />
      )}
      {pending && !isHider && (
        <section className="card waiting">
          <div>
            <p className="eyebrow">Waiting for the hiders</p>
            <h2>{questionLabel(pending)}</h2>
            <p className="muted small">Asked by {nameOf(pending.askedBy)}</p>
            {now > pending.deadlineAt && <p className="flag">Deadline missed: hiders take a shot.</p>}
          </div>
          <DeadlineRing endsAt={pending.deadlineAt} totalS={pending.deadlineS} now={now} />
        </section>
      )}
      {!play.seekingStarted && hidingLeft > 0 && (
        <section className="card started">
          <p className="eyebrow">Hiding period</p>
          <p className="countdown">{mmss(hidingLeft)}</p>
          <p className="muted small">{isHider ? 'Get to your bar and lock it in.' : 'Questions open when this hits zero.'}</p>
        </section>
      )}

      {tab === 'map' && (
        <>
          {isHider && !play.bar && (
            <BarPicker
              sync={sync}
              venues={inPlay}
              here={position?.point ?? null}
              selected={preview}
              onSelect={setPreview}
              canAct={canAct}
            />
          )}
          {isHider && play.bar && (
            <section className="card bar-locked">
              <p className="lock-label">🔒 Only you see this</p>
              <p>
                Your bar: <strong>{play.bar.name}</strong> · {radius} m circle
              </p>
            </section>
          )}
          <section className="card map-card">
            <div className="map-wrap">
              <GameMap city={lobby.city} playArea={playArea} className="play-map" overlays={mapOverlays} />
              {/* No bar count: the venue data isn't complete enough for a number to be trusted. */}
              {shading && !shading.remaining && (
                <span className="map-pill" aria-live="polite">
                  Answers conflict
                </span>
              )}
            </div>
            <p className="muted small">Hatched: ruled out by answers. Suggestions, not rulings.</p>
          </section>
          <details className="card remaining">
            <summary>
              <h2>Bars still possible</h2>
            </summary>
            <ul className="bar-list">
              {left.map((b) => (
                <li key={b.id} className="bar-row static">
                  <span>{b.name}</span>
                  {!b.inside && <span className="muted small">edge</span>}
                </li>
              ))}
            </ul>
          </details>
        </>
      )}

      {tab === 'ask' && !isHider && (
        <AskPanel
          sync={sync}
          gameId={sync.gameId}
          city={lobby.city}
          playArea={playArea}
          ruled={ruled}
          canAct={canAct}
          seekingAt={play.seekingStarted ? null : play.seekingAt}
          pending={!!pending}
          now={now}
        />
      )}

      {tab === 'questions' && (
        <section className="card">
          <h2>Questions</h2>
          {play.questions.length === 0 ? (
            <p className="muted">No questions yet.</p>
          ) : (
            <ul className="question-list">
              {[...play.questions].reverse().map((q) => (
                <li key={q.id}>
                  <strong>{questionLabel(q)}</strong>
                  <span>
                    {q.answer ? answerLabel(q.answer) : 'Waiting'}
                    {q.late && <span className="penalty"> · late</span>}
                    {q.overdue && !q.late && <span className="penalty"> · missed deadline</span>}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {tab === 'log' && <PlayLog play={play} lobby={lobby} presence={presence} />}

      <nav className="tabbar" aria-label="Game sections">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'questions' && pending && <span className="tab-dot" aria-label="needs answer" />}
          </button>
        ))}
      </nav>
    </>
  )
}
