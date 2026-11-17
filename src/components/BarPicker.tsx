import { Suspense, useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import type { StartedRound } from '../lobby/state'
import { barOptions, loadHidingBars } from '../hiding/bars'
import type { HidingZoneConfig } from '../hiding/state'
import type { Fix } from '../hiding/useGeolocation'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { formatDistance } from '../map/geo'
import type { GameSync } from '../sync/engine'
import { LazyGameMap } from './lazyMap'
import { SlideToConfirm } from './SlideToConfirm'

interface Props {
  sync: GameSync
  city: string
  started: StartedRound
  zone: HidingZoneConfig
  canAct: boolean
  fix: Fix | null
  /** Countdown text for the header, e.g. "42:10 left". */
  timeNote: string
  late: boolean
}

/** Hider: pick a bar from the valid ones (nearest first), preview its circle, slide to lock in. */
export function BarPicker({ sync, city, started, zone, canAct, fix, timeNote, late }: Props) {
  const [pack, setPack] = useState<CityPack | null>(null)
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

  const overlay = useMemo(
    () => ({
      bars: all,
      selectedBar: selected,
      zone: chosen ? { lng: chosen.lng, lat: chosen.lat, radiusM: zone.barRadiusM, team: 'hiders' as const } : null,
      dots: fix ? [{ id: 'me', lng: fix.lng, lat: fix.lat, team: 'hiders' as const, me: true }] : [],
    }),
    [all, selected, chosen, zone.barRadiusM, fix],
  )

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
            onBarTap={setSelected}
            focus={chosen ? { lng: chosen.lng, lat: chosen.lat } : null}
            hideVenues
          />
        </Suspense>
      </section>

      <section className="card">
        {loadError ? (
          <p className="bad">{loadError}</p>
        ) : !validIds ? (
          <p className="muted">Loading bars…</p>
        ) : all.length === 0 ? (
          <p className="bad">No bars in this play area. Ask the host to check the map.</p>
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
