import { Suspense, useMemo } from 'react'
import type { LobbyState, StartedRound } from '../lobby/state'
import { deriveHiding, formatClock, hidingZone, roundClock, type HidingZoneConfig } from '../hiding/state'
import { useGeolocation, type GeoError } from '../hiding/useGeolocation'
import { usePositionReporter } from '../hiding/usePositionReporter'
import { useServerNow } from '../hiding/useServerNow'
import { distanceM, formatDistance } from '../map/geo'
import type { GameSync } from '../sync/engine'
import type { Presence } from '../sync/presence'
import type { GameEvent, SeekerPosition } from '../sync/types'
import { BarPicker, LockIcon } from './BarPicker'
import { LazyGameMap } from './lazyMap'
import { PresenceDot } from './PresenceDot'

interface Props {
  sync: GameSync
  lobby: LobbyState
  userId: string | null
  canAct: boolean
  events: readonly GameEvent[]
  positions: readonly SeekerPosition[]
  presence: (userId: string) => Presence
}

/** A running round: the hider picks a bar and watches for a freeze; seekers see the countdown and each other. */
export function Round({ sync, lobby, userId, canAct, events, positions, presence }: Props) {
  const started = lobby.started
  const now = useServerNow(sync)
  const zone = useMemo(() => hidingZone(lobby.config), [lobby.config])
  if (!started) return null
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  const team = lobby.players.find((p) => p.userId === userId)?.team ?? null

  return (
    <>
      {team === 'hiders' ? (
        <HiderView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} events={events} clock={clock} />
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
        />
      ) : (
        <section className="card">
          <p className="muted">You are not on a team this round.</p>
        </section>
      )}

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

interface HiderProps {
  sync: GameSync
  lobby: LobbyState
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  events: readonly GameEvent[]
  clock: Clock
}

function HiderView({ sync, lobby, started, zone, canAct, events, clock }: HiderProps) {
  // Hider GPS stays on this phone: it only sorts bars and draws "you" on the map.
  const { fix, error } = useGeolocation(true)
  const hiding = useMemo(() => deriveHiding(events, started.round), [events, started.round])
  const bar = hiding.bar
  const overlay = useMemo(
    () => ({
      zone: bar ? { lng: bar.lng, lat: bar.lat, radiusM: bar.radiusM, team: 'hiders' as const } : null,
      dots: fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'hiders' as const, me: true }] : [],
    }),
    [bar, fix],
  )
  const focus = useMemo(() => (bar ? { lng: bar.lng, lat: bar.lat } : null), [bar])

  if (!bar) {
    return (
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
    )
  }

  const fromBar = fix ? distanceM([fix.lng, fix.lat], [bar.lng, bar.lat]) : null
  return (
    <>
      {hiding.frozen && (
        <div className="freeze-banner" role="alert">
          <strong>Freeze</strong>
          <p>A seeker is within {formatDistance(zone.freezeRadiusM)} of your bar. Don't move until this clears.</p>
        </div>
      )}
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
              <strong className={fromBar > bar.radiusM ? 'picker-late' : 'ok'}>{formatDistance(fromBar)}</strong> from it.
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
      </section>
    </>
  )
}

// ------------------------------------------------------------------ seekers

interface SeekerProps {
  sync: GameSync
  lobby: LobbyState
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  userId: string | null
  positions: readonly SeekerPosition[]
  clock: Clock
}

function SeekerView({ sync, lobby, started, zone, canAct, userId, positions, clock }: SeekerProps) {
  const { fix, error } = useGeolocation(true)
  const lastSent = usePositionReporter(sync, fix, canAct, zone.locationIntervalS, true)
  const now = useServerNow(sync, 1000)
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
    }),
    [mates, fix],
  )

  return (
    <>
      <section className="card started">
        <p className="eyebrow">{clock.phase === 'hiding' ? 'Hiding period' : 'Hiding period over'}</p>
        <p className="countdown">{formatClock(clock.ms, { up: clock.phase === 'seeking' })}</p>
        <p className="muted">
          {clock.phase === 'hiding' ? 'The hider is picking a bar. Wait for the clock.' : 'Seeking. Questions arrive next.'}
        </p>
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
      <section className="card map-card">
        <Suspense fallback={<div className="game-map play-map" />}>
          <LazyGameMap city={lobby.city} playArea={started.playArea} className="play-map" overlay={overlay} />
        </Suspense>
      </section>
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

