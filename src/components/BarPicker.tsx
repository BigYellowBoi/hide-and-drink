import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import type { StartedRound } from '../lobby/state'
import { barOptions, loadHidingBars } from '../hiding/bars'
import type { HidingZoneConfig } from '../hiding/state'
import type { Fix } from '../hiding/useGeolocation'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { packWithVenues, type VenueEdits } from '../venues/state'
import { distanceM, formatDistance } from '../map/geo'
import { radarCircle } from '../play/geo'
import { useServerNow } from '../hiding/useServerNow'
import type { GameSync } from '../sync/engine'
import type { MapDot } from './GameMap'
import { LazyGameMap } from './lazyMap'
import { MapsLink } from './MapsLink'
import { PrivateLabel } from './PrivateLabel'
import { SlideToConfirm } from './SlideToConfirm'

interface Props {
  sync: GameSync
  city: string
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  fix: Fix | null
  /** Dev/playtest mode: long-press the map to set this phone's position. */
  onLongPress?: (lngLat: [number, number]) => void
  /** Countdown text for the header, e.g. "42:10 left". */
  timeNote: string
  late: boolean
  /** Seekers' positions, with name tags. */
  seekers?: readonly MapDot[]
  /** The game's venue edits (lobby adds and hides, and bars added here). */
  venues: VenueEdits
  /** This phone's user and the other hiders, for "[name] is picking…". */
  userId?: string | null
  hiderNames?: ReadonlyMap<string, string>
  /** Picking a new bar after the Move powerup. */
  moving?: boolean
  /** Move period: only bars this close to the old one (outlined on the map). */
  within?: { lng: number; lat: number; radiusM: number } | null
  /** Move period: the bar the team is at now (the old one, or their pick so far). */
  current?: string | null
}

/** A teammate's pick counts as live for this long after its last report (they re-send every PICK_HEARTBEAT_MS). */
const PICK_TTL_MS = 45_000
const PICK_HEARTBEAT_MS = 15_000
const NO_NAMES: ReadonlyMap<string, string> = new Map()

/**
 * Hider teams: send this phone's selection to teammates (on change, then every 15 s while the
 * picker is open; none on close) and return the teammates' live picks. Hiders' topic only.
 */
function useTeamPicks(sync: GameSync, round: number, selected: string | null, canAct: boolean, userId: string | null) {
  const snap = useSyncExternalStore(sync.subscribe, sync.getSnapshot)
  const now = useServerNow(sync, 5000)
  const sel = useRef(selected)
  useEffect(() => {
    sel.current = selected
    if (!canAct) return
    const t = setTimeout(() => void sync.reportPicking(selected).catch(() => {}), 300)
    return () => clearTimeout(t)
  }, [sync, selected, canAct])
  useEffect(() => {
    if (!canAct) return
    const t = setInterval(() => void sync.reportPicking(sel.current).catch(() => {}), PICK_HEARTBEAT_MS)
    return () => clearInterval(t)
  }, [sync, canAct])
  // Closing the picker (locked in, or another tab) clears this phone's pick for the others.
  useEffect(() => () => void sync.reportPicking(null).catch(() => {}), [sync])
  return useMemo(
    () => snap.picks.filter((p) => p.userId !== userId && p.round === round && now - p.at < PICK_TTL_MS),
    [snap.picks, userId, round, now],
  )
}

const NO_DOTS: readonly MapDot[] = []

/** Hider: pick a bar from the valid ones (nearest first), preview its circle, slide to lock in. */
export function BarPicker({
  sync,
  city,
  started,
  zone,
  canAct,
  fix,
  onLongPress,
  timeNote,
  late,
  seekers = NO_DOTS,
  venues,
  userId = null,
  hiderNames = NO_NAMES,
  moving = false,
  within = null,
  current = null,
}: Props) {
  const [basePack, setPack] = useState<CityPack | null>(null)
  const pack = useMemo(() => (basePack ? packWithVenues(basePack, venues) : null), [basePack, venues])
  /** "Not listed?" form: the pin (defaults to this phone's position) and the bar's name. */
  const [adding, setAdding] = useState<{ name: string; pin: [number, number] | null } | null>(null)
  const [validIds, setValidIds] = useState<string[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!supabase) return
    let live = true
    Promise.all([loadCityPack(supabase, city), loadHidingBars(supabase, sync.gameId)])
      .then(([p, ids]) => {
        if (!live) return
        setPack(p)
        setValidIds(ids)
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : String(e)))
    return () => {
      live = false
    }
  }, [city, sync])

  // Distances move with the phone, but only re-sort every ~50 m so the list doesn't jitter.
  const fromKey = fix ? `${fix.lng.toFixed(3)},${fix.lat.toFixed(3)}` : null
  const from = useMemo(() => (fromKey ? (fromKey.split(',').map(Number) as [number, number]) : null), [fromKey])
  const inReach = useMemo(
    () => (within ? (b: { lng: number; lat: number }) => distanceM([b.lng, b.lat], [within.lng, within.lat]) <= within.radiusM : () => true),
    [within],
  )
  const all = useMemo(() => (pack && validIds ? barOptions(pack, validIds, from).filter(inReach) : []), [pack, validIds, from, inReach])
  const shown = useMemo(
    () => (pack && validIds ? barOptions(pack, validIds, from, search).filter(inReach) : []),
    [pack, validIds, from, search, inReach],
  )
  const reach = useMemo(
    () =>
      within
        ? { type: 'FeatureCollection' as const, features: [radarCircle([within.lng, within.lat], within.radiusM)] }
        : undefined,
    [within],
  )
  const chosen = all.find((b) => b.id === selected) ?? null
  const teamPicks = useTeamPicks(sync, started.round, selected, canAct, userId)
  const picking = useMemo(
    () =>
      teamPicks.map((p) => ({
        ...p,
        who: hiderNames.get(p.userId) ?? 'A teammate',
        bar: p.venueId ? (all.find((b) => b.id === p.venueId) ?? null) : null,
      })),
    [teamPicks, hiderNames, all],
  )
  const isAdding = adding !== null
  const dropped = adding?.pin ?? null
  const pin = useMemo<[number, number] | null>(
    () => (isAdding ? (dropped ?? (fix ? [fix.lng, fix.lat] : null)) : null),
    [isAdding, dropped, fix],
  )

  const overlay = useMemo(
    () => ({
      bars: all,
      selectedBar: selected,
      zone: pin
        ? { lng: pin[0], lat: pin[1], radiusM: zone.barRadiusM, team: 'hiders' as const }
        : chosen
          ? { lng: chosen.lng, lat: chosen.lat, radiusM: zone.barRadiusM, team: 'hiders' as const }
          : null,
      dots: [
        ...seekers,
        ...(fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'hiders' as const, me: true }] : []),
        ...(pin ? [{ id: 'pin', lng: pin[0], lat: pin[1], team: 'hiders' as const, name: 'New bar' }] : []),
        ...picking.flatMap((p) =>
          p.bar ? [{ id: `pick:${p.userId}`, lng: p.bar.lng, lat: p.bar.lat, team: 'hiders' as const, name: `${p.who}'s pick` }] : [],
        ),
      ],
      remaining: reach,
    }),
    [all, selected, chosen, zone.barRadiusM, fix, seekers, pin, picking, reach],
  )

  const addBar = async () => {
    if (!adding || !pin || !adding.name.trim()) return
    setBusy(true)
    setError(null)
    try {
      const res = (await sync.action('add_venue', { p_name: adding.name.trim(), p_lng: pin[0], p_lat: pin[1] })) as {
        feature_id?: unknown
      } | null
      const id = typeof res?.feature_id === 'string' ? res.feature_id : null
      if (id) {
        // The server accepted it, so choose_bar will too. Its details arrive with the
        // hider-only venue_added event.
        setValidIds((ids) => (ids && !ids.includes(id) ? [...ids, id] : ids))
        setSelected(id)
      }
      setAdding(null)
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const lockIn = async () => {
    if (!chosen) return
    setBusy(true)
    setError(null)
    try {
      await sync.action('choose_bar', { p_venue_id: chosen.id })
    } catch (e) {
      setError(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <section className="card picker-head">
        <PrivateLabel />
        <h2>{moving ? 'Pick your new bar' : 'Pick your bar'}</h2>
        <p className={late ? 'picker-late' : 'muted'}>
          {late ? 'Hiding period is over. Lock in a bar now.' : timeNote}
          {' · '}
          Hide inside or within {formatDistance(zone.barRadiusM)} of it.
        </p>
        {picking.length > 0 && (
          <ul className="team-picks" aria-live="polite">
            {picking.map((p) => (
              <li key={p.userId}>
                <span>
                  <strong>{p.who} is picking…</strong>
                  {p.bar ? (
                    <>
                      {' '}
                      <span className="muted">{p.bar.name}</span>
                    </>
                  ) : p.name ? (
                    <span className="muted"> {p.name}</span>
                  ) : (
                    <span className="muted"> nothing selected yet</span>
                  )}
                </span>
                {p.bar && p.bar.id !== selected && (
                  <button className="small secondary" onClick={() => setSelected(p.bar!.id)}>
                    View
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
        {picking.length > 0 && <p className="muted small-note">First to lock in picks the bar for the team.</p>}
      </section>

      <section className="card map-card">
        <Suspense fallback={<div className="game-map play-map" />}>
          <LazyGameMap
            city={city}
            playArea={started.playArea}
            className="picker-map"
            overlay={overlay}
            onBarTap={adding ? undefined : setSelected}
            onTap={adding ? (p) => setAdding((a) => (a ? { ...a, pin: p } : a)) : undefined}
            focus={adding ? null : chosen ? { lng: chosen.lng, lat: chosen.lat } : null}
            hideVenues
            onLongPress={onLongPress}
          />
        </Suspense>
        {chosen && !adding && (
          <div className="row map-selected">
            <span className="small">
              <strong>{chosen.name}</strong>
            </span>
            <MapsLink point={[chosen.lng, chosen.lat]} />
          </div>
        )}
      </section>

      {adding ? (
        <section className="card add-venue">
          <h3>Add a bar that isn't listed</h3>
          <p className="muted small-note">
            {pin
              ? 'Tap anywhere on the map to put the pin on the bar. It starts at your position and must be inside the play area.'
              : 'Tap the map where the bar is to drop the pin.'}{' '}
            Only your team sees it until the round ends.
          </p>
          <label className="field">
            <span>Name</span>
            <input
              value={adding.name}
              maxLength={60}
              placeholder="e.g. The Laneway Bar"
              onChange={(e) => setAdding({ ...adding, name: e.target.value })}
            />
          </label>
          <div className="row">
            <button className="small" disabled={!canAct || busy || !pin || !adding.name.trim()} onClick={() => void addBar()}>
              Add bar
            </button>
            {adding.pin && fix && (
              <button className="small secondary" disabled={busy} onClick={() => setAdding({ ...adding, pin: null })}>
                Use my location
              </button>
            )}
            <button className="small secondary" disabled={busy} onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </section>
      ) : (
        validIds && (
          <div className="row">
            <button className="small secondary" disabled={!canAct} onClick={() => setAdding({ name: '', pin: null })}>
              Not listed? Add a bar here
            </button>
          </div>
        )
      )}

      <section className="card">
        {loadError ? (
          <p className="bad">{loadError}</p>
        ) : !validIds ? (
          <p className="muted">Loading bars…</p>
        ) : all.length === 0 ? (
          <p className="bad">No bars in this play area. Add one above, or ask the host to check the map.</p>
        ) : (
          <>
            <label className="field">
              <span>
                {all.length} bars {within ? `within ${formatDistance(within.radiusM)} of your old bar, ` : ''}
                {fix ? 'by distance' : 'A to Z (no GPS fix yet)'}
              </span>
              <input type="search" placeholder="Search bars" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <ul className="bar-list" aria-label="Bars">
              {shown.map((b) => (
                <li key={b.id}>
                  <button
                    type="button"
                    className={`bar-row${b.id === selected ? ' bar-row-selected' : ''}`}
                    aria-pressed={b.id === selected}
                    onClick={() => setSelected(b.id)}
                  >
                    <span className="bar-name">
                      {b.name}
                      {b.id === current && <span className="muted"> (you're here now)</span>}
                    </span>
                    <span className="bar-meta">
                      {b.kind?.replace(/_/g, ' ')}
                      {b.distanceM !== null && ` · ${formatDistance(b.distanceM)}`}
                      {picking
                        .filter((p) => p.venueId === b.id)
                        .map((p) => (
                          <span key={p.userId} className="pick-tag">
                            {' '}
                            · {p.who}'s pick
                          </span>
                        ))}
                    </span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="muted">No bar matches “{search}”.</li>}
            </ul>
          </>
        )}
      </section>

      {/* Once a bar is selected the slider floats above the tabs, so nobody scrolls to find it. */}
      {chosen && <div className="picker-confirm-spacer" aria-hidden="true" />}
      <div className={`picker-confirm${chosen ? ' picker-confirm-floating' : ''}`}>
        {error && <p className="bad">{error}</p>}
        <SlideToConfirm
          label={chosen ? (chosen.id === current ? `Staying at ${chosen.name}` : `Lock in ${chosen.name}`) : 'Choose a bar first'}
          disabled={!chosen || !canAct || busy || chosen.id === current}
          onConfirm={() => void lockIn()}
        />
      </div>
    </>
  )
}
