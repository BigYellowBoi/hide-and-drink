import { Suspense, useEffect, useMemo, useState } from 'react'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import { supabase } from '../lib/supabase'
import { describeError } from '../lobby/messages'
import { loadCityPack, type CityPack } from '../map/cityPack'
import { polygonsOf, type AreaCollection } from '../map/playArea'
import { useGeolocation } from '../hiding/useGeolocation'
import type { GameSync } from '../sync/engine'
import { listedVenues, withVenueEdits, type VenueEdits } from '../venues/state'
import { LazyGameMap } from './lazyMap'

interface Props {
  sync: GameSync
  city: string
  playArea: AreaCollection | null
  venues: VenueEdits
  isHost: boolean
  canAct: boolean
  /** Dev/playtest mode: no GPS, drop the pin by tapping. */
  dev: boolean
}

/**
 * Lobby: the venues hiders can pick. The host taps a venue to hide it (or show it again)
 * and adds venues that aren't listed (drop a pin or use their location, give it a name).
 * Everyone sees the result; it locks at start.
 */
export function VenueEditor({ sync, city, playArea, venues, isHost, canAct, dev }: Props) {
  const [pack, setPack] = useState<CityPack | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [adding, setAdding] = useState<{ name: string; pin: [number, number] | null } | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const { fix } = useGeolocation(!!adding && !dev)

  useEffect(() => {
    if (!supabase || !open) return
    let live = true
    loadCityPack(supabase, city)
      .then((p) => live && setPack(p))
      .catch((e: unknown) => live && setErr(describeError(e)))
    return () => {
      live = false
    }
  }, [city, open])

  const inside = useMemo(() => {
    const polys = playArea ? polygonsOf(playArea) : []
    return (p: [number, number]) => polys.some((poly) => booleanPointInPolygon(p, poly))
  }, [playArea])
  const listed = useMemo(
    () => (pack && playArea ? listedVenues(withVenueEdits(pack.features, venues), inside) : []),
    [pack, playArea, venues, inside],
  )
  const names = useMemo(() => {
    const m = new Map<string, string>()
    for (const f of pack?.features ?? []) if (f.properties.layer === 'venues' && typeof f.id === 'string') m.set(f.id, f.properties.name)
    for (const v of venues.added) m.set(v.id, v.name)
    return m
  }, [pack, venues.added])
  const chosen = listed.find((v) => v.id === selected) ?? null
  const pin = adding?.pin ?? null

  const overlay = useMemo(
    () => ({
      bars: listed,
      selectedBar: selected,
      dots: pin ? [{ id: 'pin', lng: pin[0], lat: pin[1], team: 'hiders' as const, name: 'New venue' }] : [],
    }),
    [listed, selected, pin],
  )

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setErr(null)
    try {
      await fn()
      return true
    } catch (e) {
      setErr(describeError(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const setHidden = (id: string, hidden: boolean) =>
    run(() => sync.action('set_venue_hidden', { p_feature_id: id, p_hidden: hidden })).then((ok) => ok && setSelected(null))

  const add = async () => {
    if (!adding || !pin || !adding.name.trim()) return
    const ok = await run(() => sync.action('add_venue', { p_name: adding.name.trim(), p_lng: pin[0], p_lat: pin[1] }))
    if (ok) setAdding(null)
  }

  const disabled = busy || !canAct
  const custom = venues.added.filter((v) => v.round === null)

  return (
    <details className="card" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>
        <h2>Venues</h2>
      </summary>
      <p className="muted small-note">
        {custom.length} added · {venues.hidden.length} hidden
        {pack && playArea ? ` · ${listed.length} bars in the play area` : ''}
      </p>
      {open && playArea && (
        <Suspense fallback={<div className="game-map lobby-map" />}>
          <LazyGameMap
            city={city}
            playArea={playArea}
            className="lobby-map"
            overlay={overlay}
            hideVenues
            onBarTap={adding ? undefined : setSelected}
            onTap={adding ? (p) => setAdding((a) => (a ? { ...a, pin: p } : a)) : undefined}
          />
        </Suspense>
      )}
      {open && !playArea && <p className="muted">Choose a play area to see its bars.</p>}

      {isHost && chosen && !adding && (
        <div className="row venue-selected">
          <span className="bar-name">{chosen.name}</span>
          <button className="small secondary" disabled={disabled} onClick={() => void setHidden(chosen.id, true)}>
            Hide
          </button>
        </div>
      )}
      {isHost && !chosen && !adding && open && <p className="muted small-note">Tap a bar to hide it from the list.</p>}

      {isHost && adding && (
        <div className="add-venue">
          <p className="muted small-note">
            {pin ? 'Tap the map to move the pin.' : 'Tap the map where the venue is, or use your location.'}
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
            <button className="small" disabled={disabled || !pin || !adding.name.trim()} onClick={() => void add()}>
              Add venue
            </button>
            {!dev && (
              <button
                className="small secondary"
                disabled={busy || !fix}
                onClick={() => fix && setAdding({ ...adding, pin: [fix.lng, fix.lat] })}
              >
                {fix ? 'Use my location' : 'Finding you…'}
              </button>
            )}
            <button className="small secondary" disabled={busy} onClick={() => setAdding(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {isHost && !adding && open && (
        <div className="row">
          <button className="small secondary" disabled={disabled} onClick={() => setAdding({ name: '', pin: null })}>
            Add a venue
          </button>
        </div>
      )}

      {custom.length > 0 && (
        <>
          <h3>Added</h3>
          <ul className="venue-list">
            {custom.map((v) => (
              <li key={v.id} className="player-row">
                <span>{v.name}</span>
                {venues.hidden.includes(v.id) && <span className="muted"> (hidden)</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {venues.hidden.length > 0 && (
        <>
          <h3>Hidden</h3>
          <ul className="venue-list">
            {venues.hidden.map((id) => (
              <li key={id} className="player-row">
                <span>{names.get(id) ?? 'Venue'}</span>
                {isHost && (
                  <button className="small secondary" disabled={disabled} onClick={() => void setHidden(id, false)}>
                    Show
                  </button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {err && <p className="bad">{err}</p>}
    </details>
  )
}
