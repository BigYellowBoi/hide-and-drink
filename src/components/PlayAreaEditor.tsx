import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { LngLatBoundsLike, Map as MapLibreMap } from 'maplibre-gl'
import type { Polygon } from 'geojson'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRenderMode, TerraDrawSelectMode, type GeoJSONStoreFeatures } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import { importMapLink, MapLinkError } from '../map/mapLink'
import { areaKm2, boundsOf, collectionOf, formatKm2, polygonsOf, type AreaCollection } from '../map/playArea'
import { MAP_PALETTES, type MapColors } from '../map/style'
import { getMapTheme } from '../map/theme'
import { resetGestures } from '../map/gestures'
import { GameMap } from './GameMap'

export interface PlayAreaDraft {
  name: string
  area: AreaCollection
  /** Overwrite this saved area (only if you created it); null saves a new one. */
  overwriteId: string | null
  source: string | null
}

interface Props {
  city: string
  /** Area to start from (editing a saved one), or null to draw from scratch. */
  initial: AreaCollection | null
  initialName: string
  /** Set when the host owns the area being edited, so Save can overwrite it. */
  ownedId: string | null
  busy: boolean
  canAct: boolean
  onSave: (draft: PlayAreaDraft) => Promise<boolean>
  onClose: () => void
}

type Tool = 'draw' | 'edit'

const drawStyle = (c: MapColors) => ({
  fillColor: c.text,
  fillOpacity: 0.08,
  outlineColor: c.text,
  outlineWidth: 2,
  closingPointColor: c.text,
  closingPointWidth: 7,
  closingPointOutlineColor: c.bg,
  closingPointOutlineWidth: 2,
})

const toDrawFeature = (p: Polygon): GeoJSONStoreFeatures => ({
  id: crypto.randomUUID(),
  type: 'Feature',
  geometry: p,
  properties: { mode: 'polygon' },
})

/** Full-screen map where the host draws, edits or imports the play area, then saves it. */
export function PlayAreaEditor({ city, initial, initialName, ownedId, busy, canAct, onSave, onClose }: Props) {
  const drawRef = useRef<TerraDraw | null>(null)
  const [ready, setReady] = useState(false)
  const [tool, setTool] = useState<Tool>(initial ? 'edit' : 'draw')
  const [polys, setPolys] = useState<Polygon[]>(() => (initial ? polygonsOf(initial) : []))
  const [selected, setSelected] = useState<string | null>(null)
  const [name, setName] = useState(initialName)
  const [source, setSource] = useState<string | null>(initial ? null : 'Drawn in the app')
  const [link, setLink] = useState('')
  const [importing, setImporting] = useState(false)
  const [msg, setMsg] = useState<{ text: string; bad: boolean } | null>(null)
  const initialRef = useRef(initial)
  const mapRef = useRef<MapLibreMap | null>(null)

  const fitTo = (fc: AreaCollection) =>
    mapRef.current?.fitBounds(boundsOf(fc) as LngLatBoundsLike, { padding: 32, duration: 0 })

  const syncFromDraw = useCallback(() => {
    const draw = drawRef.current
    if (!draw) return
    setPolys(
      draw
        .getSnapshot()
        .filter((f) => f.properties.mode === 'polygon' && f.geometry.type === 'Polygon')
        .map((f) => f.geometry as Polygon),
    )
  }, [])

  const load = useCallback(
    (ps: Polygon[]) => {
      const draw = drawRef.current
      if (!draw) return
      draw.clear()
      const results = draw.addFeatures(ps.map(toDrawFeature))
      const bad = results.filter((r) => !r.valid).length
      if (bad) setMsg({ text: `${bad} shape${bad === 1 ? '' : 's'} couldn't be edited (self-crossing?) and were left out.`, bad: true })
      syncFromDraw()
    },
    [syncFromDraw],
  )

  const onMapReady = useCallback(
    (map: MapLibreMap) => {
      mapRef.current = map
      const colors = MAP_PALETTES[getMapTheme()]
      const draw = new TerraDraw({
        adapter: new TerraDrawMapLibreGLAdapter({ map }),
        modes: [
          new TerraDrawPolygonMode({ styles: drawStyle(colors), pointerDistance: 30 }),
          new TerraDrawSelectMode({
            pointerDistance: 30,
            flags: {
              polygon: {
                feature: {
                  draggable: true,
                  coordinates: { midpoints: true, draggable: true, deletable: true },
                },
              },
            },
            styles: {
              selectedPolygonColor: colors.text,
              selectedPolygonFillOpacity: 0.12,
              selectedPolygonOutlineColor: '#4FC88A',
              selectedPolygonOutlineWidth: 3,
              selectionPointColor: colors.text,
              selectionPointWidth: 9,
              selectionPointOutlineColor: colors.bg,
              selectionPointOutlineWidth: 2,
              midPointColor: colors.muted,
              midPointWidth: 6,
            },
          }),
          new TerraDrawRenderMode({ modeName: 'static', styles: {} }),
        ],
      })
      draw.start()
      draw.on('change', syncFromDraw)
      draw.on('finish', (id, ctx) => {
        if (ctx.action !== 'draw') return
        // Finished a shape: switch to editing with it selected.
        draw.setMode('select')
        draw.selectFeature(id)
        setTool('edit')
      })
      draw.on('select', (id) => setSelected(String(id)))
      draw.on('deselect', () => setSelected(null))
      drawRef.current = draw
      if (initialRef.current) {
        load(polygonsOf(initialRef.current))
        fitTo(initialRef.current)
      }
      draw.setMode(initialRef.current ? 'select' : 'polygon')
      setReady(true)
    },
    [load, syncFromDraw],
  )

  // Freeze the page behind the editor; it's portalled out of the scroll box so touches can't reach it.
  useEffect(() => {
    document.documentElement.classList.add('scroll-locked')
    return () => document.documentElement.classList.remove('scroll-locked')
  }, [])

  // Terra Draw turns map panning off while a corner or shape is dragged and back on at its
  // own pointer-up. A release it misses (finger lifted over the sheet, a cancelled touch)
  // would leave the map stuck, so any release with no drag in progress turns panning back on.
  useEffect(() => {
    const release = () =>
      requestAnimationFrame(() => {
        const map = mapRef.current
        if (map && !map.dragPan.isEnabled()) resetGestures(map)
      })
    window.addEventListener('pointerup', release, true)
    window.addEventListener('pointercancel', release, true)
    return () => {
      window.removeEventListener('pointerup', release, true)
      window.removeEventListener('pointercancel', release, true)
    }
  }, [])

  // Leaving the editor: stop Terra Draw (its modes and listeners) and hand the map back with
  // panning and double-tap zoom on.
  useEffect(
    () => () => {
      const draw = drawRef.current
      drawRef.current = null
      const map = mapRef.current
      mapRef.current = null
      try {
        if (draw?.enabled) {
          draw.setMode('static')
          draw.stop()
        }
        if (map) {
          resetGestures(map)
          map.doubleClickZoom.enable()
        }
      } catch {
        // The map may already be gone.
      }
    },
    [],
  )

  const pick = (t: Tool) => {
    setTool(t)
    const draw = drawRef.current
    if (!draw) return
    draw.setMode(t === 'draw' ? 'polygon' : 'select')
    // A mode switch mid-drag skips Terra Draw's own re-enable.
    if (mapRef.current) resetGestures(mapRef.current)
  }

  const deleteSelected = () => {
    if (!selected || !drawRef.current) return
    drawRef.current.removeFeatures([selected])
    setSelected(null)
    syncFromDraw()
  }

  const clearAll = () => {
    drawRef.current?.clear()
    setPolys([])
    setSelected(null)
    setSource('Drawn in the app')
    pick('draw')
  }

  const runImport = async () => {
    setImporting(true)
    setMsg(null)
    try {
      const r = await importMapLink(link)
      const ps = polygonsOf(r.area)
      load(ps)
      fitTo(r.area)
      pick('edit')
      setSource(r.source)
      if (r.name && !name.trim()) setName(r.name)
      setLink('')
      setMsg({ text: [`Imported ${ps.length} shape${ps.length === 1 ? '' : 's'}.`, ...r.notes].join(' '), bad: false })
    } catch (e) {
      setMsg({ text: e instanceof MapLinkError ? e.message : `Import failed: ${String(e)}`, bad: true })
    } finally {
      setImporting(false)
    }
  }

  const area = polys.length ? collectionOf(polys) : null
  const km2 = areaKm2(area)
  const save = async (overwrite: boolean) => {
    if (!area) return
    setMsg(null)
    const ok = await onSave({ name: name.trim(), area, overwriteId: overwrite ? ownedId : null, source })
    if (ok) onClose()
  }
  const canSave = ready && canAct && !busy && !!area && name.trim().length > 0

  return createPortal(
    <div className="editor" role="dialog" aria-modal="true" aria-label="Edit play area">
      <header className="editor-bar">
        <button className="small secondary" onClick={onClose}>
          Close
        </button>
        <span className="editor-title">Play area</span>
        <span className="editor-km">{area ? formatKm2(km2) : ''}</span>
      </header>

      <GameMap city={city} playArea={null} onReady={onMapReady} className="editor-map" tapNames={false} />

      <section className="editor-sheet">
        <div className="segmented" role="group" aria-label="Tool">
          <button className={tool === 'draw' ? 'on' : ''} aria-pressed={tool === 'draw'} disabled={!ready} onClick={() => pick('draw')}>
            Draw
          </button>
          <button className={tool === 'edit' ? 'on' : ''} aria-pressed={tool === 'edit'} disabled={!ready} onClick={() => pick('edit')}>
            Edit
          </button>
        </div>
        <p className="muted small-note">
          {tool === 'draw'
            ? 'Tap to add corners. Tap the first corner to close the shape.'
            : 'Tap a shape to select it, drag corners to move them, tap a midpoint to add one.'}
        </p>
        <div className="row editor-row">
          <button className="small secondary" disabled={!selected} onClick={deleteSelected}>
            Delete shape
          </button>
          <button className="small secondary" disabled={!polys.length} onClick={clearAll}>
            Clear all
          </button>
        </div>

        <label className="field">
          <span>Import a Hide and Seek Map Generator link</span>
          <div className="join-inline">
            <input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://taibeled.github.io/…?hzc=…"
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
            <button className="small" disabled={!ready || importing || !link.trim()} onClick={() => void runImport()}>
              {importing ? '…' : 'Import'}
            </button>
          </div>
        </label>

        <label className="field">
          <span>Name</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="e.g. CBD and West End" />
        </label>

        {msg && <p className={msg.bad ? 'bad' : 'muted'}>{msg.text}</p>}

        <div className="editor-actions">
          {ownedId && (
            <button className="wide" disabled={!canSave} onClick={() => void save(true)}>
              Save changes
            </button>
          )}
          <button className={`wide${ownedId ? ' secondary' : ''}`} disabled={!canSave} onClick={() => void save(false)}>
            {ownedId ? 'Save as new area' : 'Save and use'}
          </button>
        </div>
      </section>
    </div>,
    document.body,
  )
}
