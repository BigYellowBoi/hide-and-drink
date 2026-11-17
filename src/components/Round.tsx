import { Suspense, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import type { LobbyState, StartedRound } from '../lobby/state'
import { deriveHiding, formatClock, hidingZone, positionAge, roundClock, type HidingZoneConfig } from '../hiding/state'
import { useGeolocation, type GeoError } from '../hiding/useGeolocation'
import { usePositionReporter } from '../hiding/usePositionReporter'
import { useServerNow } from '../hiding/useServerNow'
import { useWakeLock } from '../hiding/useWakeLock'
import { readLocal, writeLocal } from '../lib/storage'
import { distanceM, formatDistance } from '../map/geo'
import { questionTool } from '../play/overlays'
import { remainingBars, shade, type HiderZone } from '../play/shading'
import { answerLabel, derivePlay, questionLabel, shadable, type PlayState, type Question } from '../play/state'
import { useHidingVenues } from '../play/useHidingVenues'
import { useSettleTimers } from '../play/useSettleTimers'
import type { GameSync } from '../sync/engine'
import type { Presence } from '../sync/presence'
import type { GameEvent, SeekerPosition } from '../sync/types'
import { AnswerSheet } from './AnswerSheet'
import { AskPanel } from './AskPanel'
import { BarPicker, LockIcon } from './BarPicker'
import { DeadlineRing } from './DeadlineRing'
import type { MapDot } from './GameMap'
import { LazyGameMap } from './lazyMap'
import { PlayLog } from './PlayLog'
import { PresenceDot } from './PresenceDot'

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

const EMPTY: FeatureCollection = { type: 'FeatureCollection', features: [] }
const AWAKE_KEY = 'hd.keepAwake'

interface Props {
  sync: GameSync
  lobby: LobbyState
  userId: string | null
  canAct: boolean
  events: readonly GameEvent[]
  positions: readonly SeekerPosition[]
  presence: (userId: string) => Presence
}

/** What every view of the round shares: question state, shading, the tool to draw. */
interface Shared {
  play: PlayState
  ruled: FeatureCollection
  /** Outline of where the hider can still be, once anything is ruled out. */
  remaining: FeatureCollection | undefined
  /** Every seeker but this phone, with name tags (both teams see them). */
  seekerDots: MapDot[]
  goMap: () => void
  /** The open question's tool (radar circle, thermometer line). */
  tool: FeatureCollection | undefined
  tab: Tab
  now: number
  nameOf: (userId: string | null) => string
}

/**
 * A running round. Bottom tabs, map first. Anything that needs action (the hider's answer
 * sheet, a freeze) sits on top until handled.
 */
export function Round({ sync, lobby, userId, canAct, events, positions, presence }: Props) {
  const started = lobby.started
  const now = useServerNow(sync)
  const zone = useMemo(() => hidingZone(lobby.config), [lobby.config])
  const play = useMemo(() => derivePlay(events), [events])
  const [tab, setTab] = useState<Tab>('map')
  useSettleTimers(sync, play, canAct, now)

  const playArea = started?.playArea ?? null
  const answered = useMemo(() => shadable(play), [play])
  const shading = useMemo(() => (playArea ? shade(playArea, answered) : null), [playArea, answered])
  const venues = useHidingVenues(lobby.city, sync.gameId)
  const left = useMemo(
    () => (playArea && shading ? remainingBars(venues, playArea, shading.remaining, zone.barRadiusM) : []),
    [venues, playArea, shading, zone.barRadiusM],
  )
  // Only while a question is open: once answered, the white outline of what's left says it all.
  const tool = useMemo(() => (play.pending ? questionTool(play.pending) : undefined), [play.pending])

  const remaining = useMemo<FeatureCollection | undefined>(
    () =>
      shading?.remaining && shading.ruledOut.features.length
        ? { type: 'FeatureCollection', features: [shading.remaining] }
        : undefined,
    [shading],
  )
  const round = started?.round
  // Ages on the tags only need to move every few seconds, not on every clock tick.
  const ageTick = Math.floor(now / 5000) * 5000
  const seekerDots = useMemo<MapDot[]>(() => {
    const seekers = new Map(lobby.players.filter((p) => p.team === 'seekers').map((p) => [p.userId, p.name]))
    return positions
      .filter((p) => p.userId !== userId && p.round === round && seekers.has(p.userId))
      .map((p) => {
        const age = positionAge(p.at, ageTick, zone.locationIntervalS)
        const name = seekers.get(p.userId) ?? 'Seeker'
        return { id: p.userId, lng: p.lng, lat: p.lat, team: 'seekers' as const, name: age ? `${name} · ${age}` : name, stale: !!age }
      })
  }, [positions, userId, round, lobby.players, ageTick, zone.locationIntervalS])

  if (!started) return null
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  const team = lobby.players.find((p) => p.userId === userId)?.team ?? null
  const tabs = team ? TABS[team] : TABS.seekers
  const nameOf = (id: string | null) => lobby.players.find((p) => p.userId === id)?.name ?? 'a seeker'
  const shared: Shared = {
    play,
    ruled: shading?.ruledOut ?? EMPTY,
    remaining,
    seekerDots,
    goMap: () => setTab('map'),
    tool,
    tab,
    now,
    nameOf,
  }

  return (
    <>
      {team === 'hiders' ? (
        <HiderView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} events={events} clock={clock} {...shared} />
      ) : team === 'seekers' ? (
        <SeekerView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} clock={clock} {...shared} />
      ) : (
        <section className="card">
          <p className="muted">You are not on a team this round.</p>
        </section>
      )}

      {tab === 'map' && answered.length > 0 && (
        // No count: the venue data isn't complete enough for a number to be trusted.
        <details className="card remaining">
          <summary>
            <h2>Bars still possible</h2>
          </summary>
          {shading && !shading.remaining ? (
            <p className="muted">The answers contradict each other: no bar fits them all.</p>
          ) : (
            <ul className="remaining-list">
              {left.map((b) => (
                <li key={b.id} className="remaining-row">
                  <span>{b.name}</span>
                  {!b.inside && <span className="muted small">edge</span>}
                </li>
              ))}
            </ul>
          )}
        </details>
      )}

      {tab === 'questions' && <QuestionList questions={play.questions} />}

      {tab === 'log' && (
        <>
          <PlayLog play={play} lobby={lobby} />
          <section className="card">
            <p className="muted">
              Round {started.round} · {started.playAreaName ?? 'Play area'}
            </p>
            <ul className="started-teams">
              {(['hiders', 'seekers'] as const).map((t) => (
                <li key={t}>
                  <strong className={`team-label-${t}`}>{t === 'hiders' ? 'Hiders' : 'Seekers'}</strong>{' '}
                  {lobby.players
                    .filter((p) => p.team === t)
                    .map((p) => (
                      <span key={p.userId} className="started-player">
                        <PresenceDot online={presence(p.userId)} />
                        {p.name}
                      </span>
                    ))}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      <nav className="tabbar" aria-label="Game sections">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'questions' && play.pending && <span className="tab-dot" aria-label="needs answer" />}
          </button>
        ))}
      </nav>
    </>
  )
}

function QuestionList({ questions }: { questions: readonly Question[] }) {
  return (
    <section className="card">
      <h2>Questions</h2>
      {questions.length === 0 ? (
        <p className="muted">No questions yet.</p>
      ) : (
        <ul className="question-list">
          {[...questions].reverse().map((q) => (
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
  )
}

type Clock = ReturnType<typeof roundClock>

/** Main clock for the top bar: hiding countdown, then time spent seeking (server time). */
export function TopbarClock({ sync, started }: { sync: GameSync; started: StartedRound }) {
  const now = useServerNow(sync)
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  return (
    <span className="topbar-clock">
      <span className="topbar-label">{clock.phase === 'hiding' ? 'Hiding' : 'Seeking'}</span>
      <span className="topbar-time">{formatClock(clock.ms, { up: clock.phase === 'seeking' })}</span>
    </span>
  )
}

// ------------------------------------------------------------------ hider

interface HiderProps extends Shared {
  sync: GameSync
  lobby: LobbyState
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  events: readonly GameEvent[]
  clock: Clock
}

function HiderView({
  sync,
  lobby,
  started,
  zone,
  canAct,
  events,
  clock,
  play,
  ruled,
  remaining,
  seekerDots,
  goMap,
  tool,
  tab,
  now,
  nameOf,
}: HiderProps) {
  // Hider GPS stays on this phone: it sorts bars, suggests answers and draws "you" on the map.
  const { fix, error } = useGeolocation(true)
  const hiding = useMemo(() => deriveHiding(events, started.round), [events, started.round])
  const bar = hiding.bar
  const overlay = useMemo(
    () => ({
      zone: bar ? { lng: bar.lng, lat: bar.lat, radiusM: bar.radiusM, team: 'hiders' as const } : null,
      dots: [...seekerDots, ...(fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'hiders' as const, me: true }] : [])],
      ruled,
      remaining,
      tool,
    }),
    [bar, fix, seekerDots, ruled, remaining, tool],
  )
  const focus = useMemo(() => (bar ? { lng: bar.lng, lat: bar.lat } : null), [bar])
  // For suggested answers. Computed here, never sent anywhere.
  const answerZone: HiderZone = useMemo(
    () => ({
      bar: bar ? { point: [bar.lng, bar.lat], radiusM: bar.radiusM } : null,
      gps: fix ? { point: [fix.lng, fix.lat], accuracyM: fix.accuracyM ?? 0 } : null,
    }),
    [bar, fix],
  )

  const fromBar = fix && bar ? distanceM([fix.lng, fix.lat], [bar.lng, bar.lat]) : null
  return (
    <>
      {hiding.frozen && (
        <div className="freeze-banner" role="alert">
          <strong>Freeze</strong>
          <p>A seeker is within {formatDistance(zone.freezeRadiusM)} of your bar. Don't move until this clears.</p>
        </div>
      )}
      {play.pending && (
        <AnswerSheet
          key={play.pending.id}
          sync={sync}
          question={play.pending}
          askerName={nameOf(play.pending.askedBy)}
          city={lobby.city}
          playArea={started.playArea}
          zone={answerZone}
          ruled={ruled}
          seekers={seekerDots}
          canAct={canAct}
          now={now}
        />
      )}
      {!bar && tab !== 'map' && (
        <section className="card pick-prompt">
          <div>
            <p className="eyebrow">
              <LockIcon /> Only you see this
            </p>
            <h2>Pick your bar</h2>
            <p className="muted small">
              {clock.phase === 'hiding' ? `${formatClock(clock.ms)} left to hide` : 'Hiding is over. Lock one in now.'}
            </p>
          </div>
          <button className="small" onClick={goMap}>
            Pick
          </button>
        </section>
      )}

      {tab === 'map' && !bar && <GeoNote error={error} waiting={!fix} />}
      {tab === 'map' &&
        (!bar ? (
          <BarPicker
            seekers={seekerDots}
            sync={sync}
            city={lobby.city}
            started={started}
            zone={zone}
            canAct={canAct}
            fix={fix}
            late={clock.phase === 'seeking'}
            timeNote={`${formatClock(clock.ms)} left to hide`}
          />
        ) : (
          <>
            <section className="card">
              <p className="eyebrow">
                <LockIcon /> Only you see this
              </p>
              <h2 className="bar-title">{bar.name}</h2>
              <p className="muted">
                Hide inside or within {formatDistance(bar.radiusM)} of it.
                {fromBar !== null && (
                  <>
                    {' '}
                    You are{' '}
                    <strong className={fromBar > bar.radiusM ? 'picker-late' : 'ok'}>{formatDistance(fromBar)}</strong>{' '}
                    from it.
                  </>
                )}
              </p>
              {!hiding.frozen && (
                <p className="ok small-note">Clear: no seeker within {formatDistance(zone.freezeRadiusM)}.</p>
              )}
              <GeoNote error={error} waiting={!fix} />
            </section>
            <section className="card map-card">
              <Suspense fallback={<div className="game-map play-map" />}>
                <LazyGameMap
                  city={lobby.city}
                  playArea={started.playArea}
                  className="play-map"
                  overlay={overlay}
                  focus={focus}
                />
              </Suspense>
              <p className="muted small">
                {seekerDots.length ? 'Tap a seeker for their distance. ' : 'No seeker positions yet. '}
                Hatched: ruled out by answers.
              </p>
            </section>
          </>
        ))}
    </>
  )
}

// ------------------------------------------------------------------ seekers

interface SeekerProps extends Shared {
  sync: GameSync
  lobby: LobbyState
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  clock: Clock
}

function SeekerView({
  sync,
  lobby,
  started,
  zone,
  canAct,
  clock,
  play,
  ruled,
  remaining,
  seekerDots,
  tool,
  tab,
  now,
  nameOf,
}: SeekerProps) {
  // Mounted for the whole round, whatever the tab, so everyone keeps getting this phone's position.
  const { fix, error } = useGeolocation(true)
  const lastSent = usePositionReporter(sync, fix, canAct, zone.locationIntervalS, true)
  // Web apps get no GPS in the background, so sharing needs the app open with the screen on.
  const [keepAwake, setKeepAwake] = useState(() => readLocal(AWAKE_KEY) !== 'off')
  const wake = useWakeLock(keepAwake)
  const overlay = useMemo(
    () => ({
      dots: [...seekerDots, ...(fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'seekers' as const, me: true }] : [])],
      ruled,
      remaining,
      tool,
    }),
    [seekerDots, fix, ruled, remaining, tool],
  )
  const pending = play.pending

  return (
    <>
      {pending && (
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

      {tab === 'map' && (
        <section className="card map-card">
          <Suspense fallback={<div className="game-map play-map" />}>
            <LazyGameMap city={lobby.city} playArea={started.playArea} className="play-map" overlay={overlay} />
          </Suspense>
          <p className="muted small">
            {clock.phase === 'hiding' ? 'Questions open when the clock hits zero. ' : ''}
            Hatched: ruled out by answers. Suggestions, not rulings.
            {fix && lastSent ? ` Sharing your location every ${Math.round(zone.locationIntervalS)} s.` : ''}
          </p>
          <GeoNote error={error} seeker />
          <label className="toggle awake-toggle">
            <input
              type="checkbox"
              checked={keepAwake}
              disabled={wake === 'unsupported'}
              onChange={(e) => {
                setKeepAwake(e.target.checked)
                writeLocal(AWAKE_KEY, e.target.checked ? 'on' : 'off')
              }}
            />
            <span>
              Keep screen on
              <span className="muted small">
                {' '}
                {wake === 'unsupported'
                  ? "This browser can't. Keep the app open and the screen unlocked to share your location."
                  : wake === 'failed'
                    ? "The phone refused (low power mode?). Your location stops when the screen locks."
                    : keepAwake
                      ? 'Your location only shares while the app is open, so one phone per group should keep this on (plug it into a power bank).'
                      : 'Your location stops sharing when the screen locks or you switch apps.'}
              </span>
            </span>
          </label>
        </section>
      )}

      {tab === 'ask' && (
        <AskPanel
          sync={sync}
          gameId={sync.gameId}
          city={lobby.city}
          playArea={started.playArea}
          ruled={ruled}
          canAct={canAct}
          seekingAt={clock.phase === 'hiding' ? now + clock.ms : null}
          pending={!!pending}
          now={now}
          fix={fix}
          geoError={error}
        />
      )}
    </>
  )
}


function GeoNote({ error, seeker = false, waiting = false }: { error: GeoError | null; seeker?: boolean; waiting?: boolean }) {
  if (!error) {
    return waiting ? <p className="muted small-note">Waiting for GPS: you'll appear on the map once it has a fix.</p> : null
  }
  const why = seeker
    ? " Nobody can see you and the hider's freeze alert can't use your position."
    : " You won't appear on the map and answer suggestions can't use your position."
  const text =
    error === 'denied'
      ? `Location is blocked. Allow it for this app in your browser settings.${why}`
      : error === 'unsupported'
        ? `This browser has no location.${why}`
        : `Can't get a GPS fix right now.${why}`
  return <p className="bad small-note">{text}</p>
}
