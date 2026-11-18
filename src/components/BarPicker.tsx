import { Suspense, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import type { StartedRound } from '../lobby/state'
import { barOptions, loadHidingBars } from '../hiding/bars'
import type { HidingZoneConfig } from '../hiding/state'
import type { Fix } from '../hiding/useGeolocation'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { packWithVenues, type VenueEdits } from '../venues/state'
import { formatDistance } from '../map/geo'
import type { GameSync } from '../sync/engine'
import type { MapDot } from './GameMap'
import { LazyGameMap } from './lazyMap'
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
}

const NO_DOTS: readonly MapDot[] = []

/** Hider: pick a bar from the valid ones (nearest first), preview its circle, slide to lock in. */
export function BarPicker({ sync, city, started, zone, canAct, fix, onLongPress, timeNote, late, seekers = NO_DOTS, venues }: Props) {
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
  const all = useMemo(() => (pack && validIds ? barOptions(pack, validIds, from) : []), [pack, validIds, from])
  const shown = useMemo(() => (pack && validIds ? barOptions(pack, validIds, from, search) : []), [pack, validIds, from, search])
  const chosen = all.find((b) => b.id === selected) ?? null
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
      ],
    }),
    [all, selected, chosen, zone.barRadiusM, fix, seekers, pin],
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
        <p className="eyebrow">
          <LockIcon /> Only you see this
        </p>
        <h2>Pick your bar</h2>
        <p className={late ? 'picker-late' : 'muted'}>
          {late ? 'Hiding period is over. Lock in a bar now.' : timeNote}
          {' · '}
          Hide inside or within {formatDistance(zone.barRadiusM)} of it.
        </p>
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
                {all.length} bars {fix ? 'by distance' : 'A to Z (no GPS fix yet)'}
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
                    <span className="bar-name">{b.name}</span>
                    <span className="bar-meta">
                      {b.kind?.replace(/_/g, ' ')}
                      {b.distanceM !== null && ` · ${formatDistance(b.distanceM)}`}
                    </span>
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="muted">No bar matches “{search}”.</li>}
            </ul>
          </>
        )}
      </section>

      <div className="picker-confirm">
        {error && <p className="bad">{error}</p>}
        <SlideToConfirm
          label={chosen ? `Lock in ${chosen.name}` : 'Choose a bar first'}
          disabled={!chosen || !canAct || busy}
          onConfirm={() => void lockIn()}
        />
      </div>
    </>
  )
}

export function LockIcon() {
  return (
    <svg className="lock-icon" viewBox="0 0 24 24" width="13" height="13" aria-hidden="true">
      <rect x="5" y="11" width="14" height="10" rx="2" fill="currentColor" />
      <path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" strokeWidth="2.2" />
    </svg>
  )
}
