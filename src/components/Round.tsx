import { Suspense, useMemo, useState } from 'react'
import type { FeatureCollection } from 'geojson'
import type { LobbyState, StartedRound } from '../lobby/state'
import { deriveHiding, formatClock, hidingZone, positionAge, roundClock, type HidingZoneConfig } from '../hiding/state'
import type { GeoError } from '../hiding/useGeolocation'
import { isDevMode } from '../hiding/devPosition'
import { usePosition } from '../hiding/usePosition'
import { usePositionReporter } from '../hiding/usePositionReporter'
import { useServerNow } from '../hiding/useServerNow'
import { useWakeLock } from '../hiding/useWakeLock'
import { readLocal, writeLocal } from '../lib/storage'
import { distanceM, formatDistance } from '../map/geo'
import { questionTool } from '../play/overlays'
import { shade, type HiderZone } from '../play/shading'
import { derivePlay, questionLabel, shadable, type PlayState } from '../play/state'
import { useQuestionTypes } from '../play/useQuestionTypes'
import { shadingBounds, type LayerLookup } from '../play/features'
import { useCityLayers } from '../play/useCityLayers'
import { useSettleTimers } from '../play/useSettleTimers'
import {
  bannedSet,
  cardOf,
  deriveCards,
  evidenceFor,
  liveEffects,
  lockedUntil,
  powerupAction,
  questionsBlockedBy,
  triviaWaiting,
  vetoable,
  type CardsState,
} from '../cards/state'
import { DrinkProofs, LockBanner } from './CardExtras'
import type { GameSync } from '../sync/engine'
import type { Presence } from '../sync/presence'
import type { GameEvent, SeekerPosition } from '../sync/types'
import { AnswerSheet } from './AnswerSheet'
import { AskPanel } from './AskPanel'
import { BarPicker } from './BarPicker'
import { HiderCountContext } from './hiderCount'
import { PrivateLabel } from './PrivateLabel'
import { DeadlineRing } from './DeadlineRing'
import { timerTone } from '../lib/timers'
import { useTimerAlert } from '../lib/useTimerAlert'
import { BlockedBanner, ConfirmClear, EffectStrip, EffectsPanel, TriviaPrompt } from './EffectsPanel'
import { HandPanel } from './HandPanel'
import type { MapDot } from './GameMap'
import { LazyGameMap } from './lazyMap'
import { Timeline } from './Timeline'
import { MapsLink } from './MapsLink'
import { ManualShadeSheet } from './ManualShadeSheet'
import { PresenceDot } from './PresenceDot'

type Tab = 'map' | 'ask' | 'hand' | 'effects' | 'log'
const TABS = {
  hiders: [
    ['map', 'Map'],
    ['hand', 'Hand'],
    ['log', 'Timeline'],
  ],
  seekers: [
    ['map', 'Map'],
    ['ask', 'Ask'],
    ['effects', 'Effects'],
    ['log', 'Timeline'],
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
  cards: CardsState
  ruled: FeatureCollection
  /** Outline of where the hider can still be, once anything is ruled out. */
  remaining: FeatureCollection | undefined
  /** Every seeker but this phone, with name tags (both teams see them). */
  seekerDots: MapDot[]
  goMap: () => void
  goHand: () => void
  goEffects: () => void
  /** The host can mark a trivia curse all correct by hand. */
  isHost: boolean
  /** The open question's tool (radar circle, thermometer line). */
  tool: FeatureCollection | undefined
  tab: Tab
  now: number
  nameOf: (userId: string | null) => string
  layer: LayerLookup | null
  /** Dev/playtest mode: positions come from long-pressing the map, not GPS. */
  dev: boolean
  userId: string | null
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
  const cards = useMemo(() => deriveCards(events), [events])
  const log = useMemo(() => [...play.log, ...cards.log].sort((a, b) => a.seq - b.seq), [play.log, cards.log])
  const [tab, setTab] = useState<Tab>('map')
  /** A past question shown on the map from the timeline (its tool, candidates and distances). */
  const [shownId, setShownId] = useState<string | null>(null)
  /** The answered question the seekers are shading by hand. */
  const [shadeId, setShadeId] = useState<string | null>(null)
  const questionTypes = useQuestionTypes(lobby.city)
  useSettleTimers(sync, play, canAct, now)

  const playArea = started?.playArea ?? null
  const answered = useMemo(() => shadable(play), [play])
  const layer = useCityLayers(lobby.city, lobby.venues)
  const ctx = useMemo(
    () => (layer && playArea ? { layer, bounds: shadingBounds(playArea), barRadiusM: zone.barRadiusM } : undefined),
    [layer, playArea, zone.barRadiusM],
  )
  const shading = useMemo(() => (playArea ? shade(playArea, answered, ctx) : null), [playArea, answered, ctx])
  // While a question is open, or one picked from the timeline: otherwise the white outline of
  // what's left says it all.
  const shownQ = play.pending ?? play.questions.find((q) => q.id === shownId) ?? null
  const tool = useMemo(() => (shownQ ? questionTool(shownQ, layer) : undefined), [shownQ, layer])
  const shadeQ = play.questions.find((q) => q.id === shadeId) ?? null

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
  const hiderCount = lobby.players.filter((p) => p.team === 'hiders').length
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  const team = lobby.players.find((p) => p.userId === userId)?.team ?? null
  const tabs = team ? TABS[team] : TABS.seekers
  const nameOf = (id: string | null) => lobby.players.find((p) => p.userId === id)?.name ?? 'a seeker'
  const shared: Shared = {
    play,
    cards,
    ruled: shading?.ruledOut ?? EMPTY,
    remaining,
    seekerDots,
    goMap: () => setTab('map'),
    goHand: () => setTab('hand'),
    goEffects: () => setTab('effects'),
    isHost: !!userId && userId === lobby.hostId,
    tool,
    tab,
    now,
    nameOf,
    layer,
    dev: isDevMode(lobby.config),
    userId,
  }

  return (
    <HiderCountContext.Provider value={hiderCount}>
      {team === 'hiders' ? (
        <HiderView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} events={events} clock={clock} {...shared} />
      ) : team === 'seekers' ? (
        <SeekerView sync={sync} lobby={lobby} started={started} zone={zone} canAct={canAct} clock={clock} {...shared} />
      ) : (
        <section className="card">
          <p className="muted">You are not on a team this round.</p>
        </section>
      )}

      {tab === 'map' && !play.pending && shownQ && (
        <div className="shown-chip" role="status">
          <span>
            Showing <strong>{questionLabel(shownQ)}</strong>
          </span>
          <button className="small secondary" onClick={() => setShownId(null)}>
            Hide
          </button>
        </div>
      )}

      {tab === 'effects' && team && (
        <EffectsPanel sync={sync} cards={cards} team={team} canAct={canAct} now={now} config={lobby.config} nameOf={nameOf} isHost={shared.isHost} />
      )}

      {tab === 'log' && (
        <>
          <Timeline
            questions={play.questions}
            log={log}
            lobby={lobby}
            types={questionTypes}
            team={team}
            round={started.round}
            canAct={canAct}
            shownId={shownQ?.id ?? null}
            nameOf={nameOf}
            onShow={(q) => {
              setShownId(q.id)
              setTab('map')
            }}
            onShade={(q) => setShadeId(q.id)}
          />
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

      {shadeQ && team === 'seekers' && (
        <ManualShadeSheet
          sync={sync}
          question={shadeQ}
          city={lobby.city}
          playArea={playArea}
          ruled={shading?.ruledOut ?? EMPTY}
          layer={layer}
          canAct={canAct}
          onClose={() => setShadeId(null)}
        />
      )}

      <nav className="tabbar" aria-label="Game sections">
        {tabs.map(([id, label]) => (
          <button key={id} className={tab === id ? 'on' : ''} aria-current={tab === id} onClick={() => setTab(id)}>
            {label}
            {id === 'log' && team === 'hiders' && play.pending && <span className="tab-dot" aria-label="needs answer" />}
            {id === 'hand' && (cards.draws.length > 0 || triviaWaiting(cards, 'hiders').length > 0) && (
              <span className="tab-dot" aria-label="cards to act on" />
            )}
            {id === 'effects' &&
              (liveEffects(cards, now).length > 0 || cards.played.some((p) => vetoable(cards, p, now))) && (
                <span className="tab-dot" aria-label="curses in play" />
              )}
          </button>
        ))}
      </nav>
    </HiderCountContext.Provider>
  )
}

type Clock = ReturnType<typeof roundClock>

/**
 * Main clock for the top bar: hiding countdown, then time spent seeking (server time). On the
 * hider's phone only, bonusS is the time bonus held in hand, shown as "+X min".
 */
export function TopbarClock({ sync, started, bonusS = 0 }: { sync: GameSync; started: StartedRound; bonusS?: number }) {
  const now = useServerNow(sync)
  const clock = roundClock(started.startedAt, started.hidingPeriodS, now)
  const hidingLeft = clock.phase === 'hiding' ? clock.ms : started.startedAt + started.hidingPeriodS * 1000 - now
  // Buzz a minute before seeking starts and when it does (every phone, both teams).
  useTimerAlert(`hiding:${started.round}`, hidingLeft)
  const tone = clock.phase === 'hiding' ? timerTone(clock.ms) : 'ok'
  // Flash "Seeking" for the first few seconds after the hiding period ends.
  const justStarted = clock.phase === 'seeking' && clock.ms < 5000
  return (
    <span className={`topbar-clock topbar-${tone}${justStarted ? ' topbar-flash' : ''}`} role="timer">
      <span className="topbar-label">{clock.phase === 'hiding' ? 'Hiding' : 'Seeking'}</span>
      <span className="topbar-time">
        {formatClock(clock.ms, { up: clock.phase === 'seeking' })}
        {bonusS > 0 && <span className="topbar-bonus"> +{Math.round(bonusS / 60)} min</span>}
      </span>
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
  cards,
  ruled,
  remaining,
  seekerDots,
  goMap,
  goHand,
  isHost,
  tool,
  tab,
  now,
  nameOf,
  layer,
  dev,
  userId,
}: HiderProps) {
  // Hider GPS (or playtest point) stays on this phone: it sorts bars, suggests answers and draws "you" on the map.
  const { fix, error, place } = usePosition(dev, sync.gameId, userId)
  const hiding = useMemo(() => deriveHiding(events, started.round), [events, started.round])
  const bar = hiding.bar
  const picking = !bar || hiding.moving
  const hiderNames = useMemo(
    () => new Map(lobby.players.filter((p) => p.team === 'hiders').map((p) => [p.userId, p.name])),
    [lobby.players],
  )
  // Veto / Randomize in hand: offered right on the answer sheet.
  const powerups = cards.hand.flatMap((c) => {
    const def = cardOf(cards, c.cardId)
    const a = powerupAction(def)
    return a === 'veto' || a === 'randomize' ? [{ instanceId: c.instanceId, name: def.name, action: a }] : []
  })
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
      <DrinkProofs sync={sync} cards={cards} team="hiders" canAct={canAct} />
      {hiding.moving && (
        <div className="blocked-banner" role="status">
          <strong>Moving</strong>
          <p>Pick your new bar on the Map tab. Seekers can't ask until you lock it in.</p>
        </div>
      )}
      <LockBanner cards={cards} team="hiders" now={now} />
      {play.pending && (
        <AnswerSheet
          key={play.pending.id}
          powerups={powerups}
          rewardMultiplier={cards.nextRewardMultiplier}
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
          layer={layer ?? undefined}
          venues={lobby.venues}
        />
      )}
      {cards.effects
        .filter((e) => e.status === 'clear_requested')
        .map((e) => (
          <ConfirmClear key={e.id} sync={sync} effect={e} canAct={canAct} proofPath={evidenceFor(cards, e.id)?.path ?? null} />
        ))}
      {tab !== 'hand' && <TriviaPrompt effects={triviaWaiting(cards, 'hiders')} team="hiders" onOpen={goHand} />}
      {cards.draws.length > 0 && tab !== 'hand' && (
        <section className="card pick-prompt">
          <div>
            <PrivateLabel />
            <h2>
              Keep {cards.draws[0].pick} of {cards.draws[0].cards.length} cards
            </h2>
          </div>
          <button className="small" onClick={goHand}>
            Pick
          </button>
        </section>
      )}
      {tab === 'hand' && (
        <>
          <HandPanel
            sync={sync}
            cards={cards}
            canAct={canAct}
            ctx={{ city: lobby.city, pendingQuestion: !!play.pending, barChosen: !!bar }}
          />
          <EffectsPanel
            sync={sync}
            cards={cards}
            team="hiders"
            canAct={canAct}
            now={now}
            config={lobby.config}
            nameOf={nameOf}
            isHost={isHost}
          />
        </>
      )}
      {picking && tab !== 'map' && (
        <section className="card pick-prompt">
          <div>
            <PrivateLabel />
            <h2>{hiding.moving ? 'Pick your new bar' : 'Pick your bar'}</h2>
            <p className="muted small">
              {hiding.moving
                ? 'You played Move.'
                : clock.phase === 'hiding'
                  ? `${formatClock(clock.ms)} left to hide`
                  : 'Hiding is over. Lock one in now.'}
            </p>
          </div>
          <button className="small" onClick={goMap}>
            Pick
          </button>
        </section>
      )}

      {tab === 'map' && picking && <GeoNote error={error} waiting={!fix} dev={dev} />}
      {tab === 'map' &&
        (picking || !bar ? (
          <BarPicker
            seekers={seekerDots}
            venues={lobby.venues}
            sync={sync}
            city={lobby.city}
            started={started}
            zone={zone}
            canAct={canAct}
            fix={fix}
            onLongPress={place}
            moving={hiding.moving}
            userId={userId}
            hiderNames={hiderNames}
            late={clock.phase === 'seeking' && !hiding.moving}
            timeNote={hiding.moving ? `Moving from ${bar?.name ?? 'your bar'}` : `${formatClock(clock.ms)} left to hide`}
          />
        ) : (
          <>
            <section className="card">
              <PrivateLabel />
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
              <MapsLink point={[bar.lng, bar.lat]} />
              <GeoNote error={error} waiting={!fix} dev={dev} />
            </section>
            <EffectStrip cards={cards} now={now} />
            <section className="card map-card">
              <Suspense fallback={<div className="game-map play-map" />}>
                <LazyGameMap
                  city={lobby.city}
                  playArea={started.playArea}
                  className="play-map"
                  overlay={overlay}
                  focus={focus}
                  onLongPress={place}
                  venues={lobby.venues}
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
  cards,
  ruled,
  remaining,
  seekerDots,
  tool,
  tab,
  goEffects,
  now,
  nameOf,
  layer,
  dev,
  userId,
}: SeekerProps) {
  // Mounted for the whole round, whatever the tab, so everyone keeps getting this phone's position
  // (in playtest mode, the point long-pressed on the map).
  const { fix, error, place } = usePosition(dev, sync.gameId, userId)
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
  const blocked = questionsBlockedBy(cards)
  const banned = useMemo(() => bannedSet(cards), [cards])
  const locked = lockedUntil(cards, now)

  return (
    <>
      <DrinkProofs sync={sync} cards={cards} team="seekers" canAct={canAct} />
      {blocked.length > 0 && tab !== 'effects' && <BlockedBanner effects={blocked} team="seekers" />}
      {tab !== 'effects' && <LockBanner cards={cards} team="seekers" now={now} />}
      {cards.moving && tab !== 'effects' && (
        <div className="blocked-banner" role="status">
          <strong>Hider is moving</strong>
          <p>Stay put: questions open once they lock in a new bar.</p>
        </div>
      )}
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

      {tab !== 'effects' && <TriviaPrompt effects={triviaWaiting(cards, 'seekers')} team="seekers" onOpen={goEffects} />}
      {tab === 'map' && <EffectStrip cards={cards} now={now} />}
      {tab === 'map' && (
        <section className="card map-card">
          <Suspense fallback={<div className="game-map play-map" />}>
            <LazyGameMap
              city={lobby.city}
              playArea={started.playArea}
              className="play-map"
              overlay={overlay}
              onLongPress={place}
              // Bar dots are for the hider only; seekers work it out from the answers.
              hideVenues
            />
          </Suspense>
          <p className="muted small">
            {clock.phase === 'hiding' ? 'Questions open when the clock hits zero. ' : ''}
            Hatched: ruled out by answers. Suggestions, not rulings.
            {fix && lastSent ? ` Sharing your location every ${Math.round(zone.locationIntervalS)} s.` : ''}
          </p>
          <GeoNote error={error} seeker dev={dev} waiting={dev && !fix} />
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
          blocked={
            blocked.length
              ? `Questions are blocked until you complete ${blocked.map((e) => e.card.name).join(' and ')}.`
              : cards.moving
                ? 'The hider is moving. Questions open once they lock in a new bar.'
                : null
          }
          banned={banned}
          locked={!!locked}
          now={now}
          fix={fix}
          geoError={error}
          onLongPress={place}
          layer={layer}
        />
      )}
    </>
  )
}


function GeoNote({
  error,
  seeker = false,
  waiting = false,
  dev = false,
}: {
  error: GeoError | null
  seeker?: boolean
  waiting?: boolean
  dev?: boolean
}) {
  if (dev) {
    return (
      <p className={`${waiting ? 'dev-note' : 'muted'} small-note`}>
        {waiting
          ? 'Playtest mode: long-press the map to set your position.'
          : 'Playtest mode: long-press the map to move yourself.'}
      </p>
    )
  }
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
