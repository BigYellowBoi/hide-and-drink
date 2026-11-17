import { Suspense, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import type { LobbyState, StartedRound } from '../lobby/state'
import { deriveHiding, formatClock, hidingZone, roundClock, type HidingZoneConfig } from '../hiding/state'
import { useGeolocation, type GeoError } from '../hiding/useGeolocation'
import { usePositionReporter } from '../hiding/usePositionReporter'
import { useServerNow } from '../hiding/useServerNow'
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
  /** The pending question's tool, else the last answered one's. */
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
  const tool = useMemo(() => {
    const q = play.pending ?? answered[answered.length - 1]
    return q ? questionTool(q) : undefined
  }, [play.pending, answered])

  if (!started) return null
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  const team = lobby.players.find((p) => p.userId === userId)?.team ?? null
  const tabs = team ? TABS[team] : TABS.seekers
  const nameOf = (id: string | null) => lobby.players.find((p) => p.userId === id)?.name ?? 'a seeker'
  const shared: Shared = { play, ruled: shading?.ruledOut ?? EMPTY, tool, tab, now, nameOf }

  return (
    <>
      {team === 'hiders' ? (
        <HiderView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} events={events} clock={clock} {...shared} />
      ) : team === 'seekers' ? (
        <SeekerView
          sync={sync}
          lobby={lobby}
          started={started}
          zone={zone}
          canAct={canAct}
          userId={userId}
          positions={positions}
          clock={clock}
          {...shared}
        />
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

function HiderView({ sync, lobby, started, zone, canAct, events, clock, play, ruled, tool, tab, now, nameOf }: HiderProps) {
  // Hider GPS stays on this phone: it sorts bars, suggests answers and draws "you" on the map.
  const { fix, error } = useGeolocation(true)
  const hiding = useMemo(() => deriveHiding(events, started.round), [events, started.round])
  const bar = hiding.bar
  const overlay = useMemo(
    () => ({
      zone: bar ? { lng: bar.lng, lat: bar.lat, radiusM: bar.radiusM, team: 'hiders' as const } : null,
      dots: fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'hiders' as const, me: true }] : [],
      ruled,
      tool,
    }),
    [bar, fix, ruled, tool],
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
          canAct={canAct}
          now={now}
        />
      )}

      {tab === 'map' &&
        (!bar ? (
          <BarPicker
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
              <GeoNote error={error} />
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
              <p className="muted small">Hatched: ruled out by answers.</p>
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
  userId: string | null
  positions: readonly SeekerPosition[]
  clock: Clock
}

function SeekerView({
  sync,
  lobby,
  started,
  zone,
  canAct,
  userId,
  positions,
  clock,
  play,
  ruled,
  tool,
  tab,
  now,
  nameOf,
}: SeekerProps) {
  // Mounted for the whole round, whatever the tab, so the team keeps getting this phone's position.
  const { fix, error } = useGeolocation(true)
  const lastSent = usePositionReporter(sync, fix, canAct, zone.locationIntervalS, true)
  const names = useMemo(() => new Map(lobby.players.map((p) => [p.userId, p.name])), [lobby.players])

  // Teammates from the server; this phone from its own GPS (fresher than its last report).
  const mates = useMemo(
    () => positions.filter((p) => p.userId !== userId && p.round === started.round && names.has(p.userId)),
    [positions, userId, started.round, names],
  )
  const overlay = useMemo(
    () => ({
      dots: [
        ...mates.map((p) => ({ id: p.userId, lng: p.lng, lat: p.lat, team: 'seekers' as const })),
        ...(fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'seekers' as const, me: true }] : []),
      ],
      ruled,
      tool,
    }),
    [mates, fix, ruled, tool],
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
        <>
          {clock.phase === 'hiding' && (
            <section className="card started">
              <p className="eyebrow">Hiding period</p>
              <p className="countdown">{formatClock(clock.ms)}</p>
              <p className="muted">The hider is picking a bar. Questions open when the clock hits zero.</p>
            </section>
          )}
          <section className="card map-card">
            <Suspense fallback={<div className="game-map play-map" />}>
              <LazyGameMap city={lobby.city} playArea={started.playArea} className="play-map" overlay={overlay} />
            </Suspense>
            <p className="muted small">Hatched: ruled out by answers. Suggestions, not rulings.</p>
          </section>
          <section className="card">
            <p className="eyebrow">Your team</p>
            <ul className="mate-list">
              {mates.map((p) => (
                <li key={p.userId}>
                  <span className="mate-dot" aria-hidden="true" />
                  {names.get(p.userId)}
                  <span className="muted"> · {ago(now - p.at)}</span>
                </li>
              ))}
              {mates.length === 0 && <li className="muted">No teammate positions yet.</li>}
            </ul>
            <p className="muted small-note">
              {fix
                ? lastSent
                  ? `Sharing your location with your team every ${Math.round(zone.locationIntervalS)} s.`
                  : 'Sharing your location once connected.'
                : null}
            </p>
            <GeoNote error={error} seeker />
          </section>
        </>
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

function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`
}

function GeoNote({ error, seeker = false }: { error: GeoError | null; seeker?: boolean }) {
  if (!error) return null
  const why = seeker ? " Your team can't see you and the hider's freeze alert can't use your position." : ''
  const text =
    error === 'denied'
      ? `Location is blocked. Allow it for this app in your browser settings.${why}`
      : error === 'unsupported'
        ? `This browser has no location.${why}`
        : `Can't get a GPS fix right now.${why}`
  return <p className="bad small-note">{text}</p>
}
