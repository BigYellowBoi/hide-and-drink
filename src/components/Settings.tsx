import { Suspense, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { SyncTransport } from '../sync/transport'
import { deletePlayArea, isBuiltIn, listPlayAreas, madeBy, type PlayAreaSummary } from '../lobby/playAreas'
import { describeError } from '../lobby/messages'
import { areaKm2, formatKm2 } from '../map/playArea'
import { LazyGameMap } from './lazyMap'
import { useLibrary } from '../library/useLibrary'
import { CardLibrary } from './CardLibrary'
import { PushToggle } from './PushToggle'
import { AdminPin } from './AdminPin'
import { buildLabel } from '../lib/version'

const cityLabel = (c: string) => c.charAt(0).toUpperCase() + c.slice(1).replace(/_/g, ' ')

/** App settings, opened from the cog on Home: the shared card library and the saved maps list. */
export function Settings({ transport, onBack }: { transport: SyncTransport; onBack: () => void }) {
  const [areas, setAreas] = useState<PlayAreaSummary[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Area whose delete button has been tapped once (tap again to confirm). */
  const [arming, setArming] = useState<string | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [libraryOpen, setLibraryOpen] = useState(false)
  const { library, error: libraryError } = useLibrary(transport)

  useEffect(() => {
    if (areas || !supabase) return
    const client = supabase
    transport
      .signIn()
      .then(() => listPlayAreas(client))
      .then(setAreas)
      .catch((e: unknown) => setErr(describeError(e)))
  }, [areas, transport])

  // Disarm after a few seconds, like removing a player.
  useEffect(() => {
    if (!arming) return
    const t = setTimeout(() => setArming(null), 3000)
    return () => clearTimeout(t)
  }, [arming])

  const remove = async (a: PlayAreaSummary) => {
    if (arming !== a.id) return setArming(a.id)
    setArming(null)
    setBusy(true)
    setErr(null)
    try {
      await deletePlayArea(transport, a.id)
      setAreas((list) => list?.filter((x) => x.id !== a.id) ?? null)
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  const cities = [...new Set((areas ?? []).map((a) => a.city))]

  return (
    <>
      <header className="settings-bar">
        <button className="small secondary" onClick={onBack}>
          Back
        </button>
        <h1 className="settings-title">Settings</h1>
        <span />
      </header>

      <section className="card">
        <p className="muted small">
          App version <strong>{buildLabel()}</strong>. If a teammate shows a higher number, close and reopen the app to update.
        </p>
      </section>

      <section className="card">
        <PushToggle transport={transport} />
      </section>

      <section className="card">
        <AdminPin transport={transport} />
      </section>

      <section className="card">
        <h2>Card library</h2>
        <p className="muted small-note">
          Add, edit and retire cards and categories. Shared with everyone and live on every phone; games already running
          keep their own copy.
        </p>
        <p className="deck-total">
          {library
            ? `${library.cards.filter((c) => c.active).length} cards in ${library.categories.filter((c) => c.active).length} categories`
            : 'Loading…'}
        </p>
        <div className="row">
          <button className="small secondary" onClick={() => setLibraryOpen(true)}>
            Edit card library
          </button>
        </div>
      </section>

      {libraryOpen && (
        <CardLibrary
          transport={transport}
          library={library}
          loadError={libraryError}
          canAct
          onClose={() => setLibraryOpen(false)}
        />
      )}

      <section className="card">
        <h2>Saved maps</h2>
        <p className="muted small-note">
          Delete test maps so the lobby list stays short. Built-in maps stay. A map a lobby is using can't be deleted.
        </p>
        {!areas && !err && <p className="muted">Loading…</p>}
        {cities.map((city) => (
          <div key={city} className="map-list">
            {cities.length > 1 && <h3>{cityLabel(city)}</h3>}
            <ul>
              {areas!
                .filter((a) => a.city === city)
                .map((a) => (
                  <li key={a.id} className="map-row">
                    <div className="map-row-main">
                      <button
                        className="map-row-name"
                        aria-expanded={open === a.id}
                        onClick={() => setOpen(open === a.id ? null : a.id)}
                      >
                        <span className="map-row-title">{a.name}</span>
                        <span className="map-tag">
                          {madeBy(a)}
                          {a.area ? ` · ${formatKm2(areaKm2(a.area))}` : ''}
                        </span>
                      </button>
                      {!isBuiltIn(a) && (
                        <button
                          className={`small secondary map-row-delete${arming === a.id ? ' danger' : ''}`}
                          disabled={busy}
                          aria-label={arming === a.id ? `Tap again to delete ${a.name}` : `Delete ${a.name}`}
                          onClick={() => void remove(a)}
                        >
                          {arming === a.id ? 'Delete?' : 'Delete'}
                        </button>
                      )}
                    </div>
                    {open === a.id && a.area && (
                      <Suspense fallback={<div className="game-map settings-map" />}>
                        <LazyGameMap city={a.city} playArea={a.area} className="settings-map" />
                      </Suspense>
                    )}
                  </li>
                ))}
            </ul>
          </div>
        ))}
        {areas && areas.length === 0 && <p className="muted">No saved maps yet.</p>}
      </section>

      {err && (
        <p className="bad sticky-error" role="alert">
          {err}
        </p>
      )}
    </>
  )
}
