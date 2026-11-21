import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { Map as MapLibreMap } from 'maplibre-gl'
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'
import booleanPointInPolygon from '@turf/boolean-point-in-polygon'
import turfArea from '@turf/area'
import { TerraDraw, TerraDrawPolygonMode, TerraDrawRenderMode } from 'terra-draw'
import { TerraDrawMapLibreGLAdapter } from 'terra-draw-maplibre-gl-adapter'
import type { GameSync } from '../sync/engine'
import type { AreaCollection } from '../map/playArea'
import { MAP_PALETTES, type MapColors } from '../map/style'
import { getMapTheme } from '../map/theme'
import { resetGestures } from '../map/gestures'
import { describeError } from '../lobby/messages'
import { questionTool } from '../play/overlays'
import { featureId, unionAll, type LayerLookup } from '../play/features'
import type { Area, LngLat } from '../play/geo'
import { questionText, type Question } from '../play/state'
import { manualAreaPoints, MAX_SHADING_POINTS, PICK_LAYERS } from '../play/manualShading'
import { GameMap } from './GameMap'

interface Props {
  sync: GameSync
  question: Question
  city: string
  playArea: AreaCollection | null
  ruled: FeatureCollection
  layer: LayerLookup | null
  canAct: boolean
  onClose: () => void
}

type Mode = 'keep' | 'cut' | 'none'
type Tool = 'pick' | 'draw'

const drawStyle = (c: MapColors) => ({
  fillColor: c.seeker,
  fillOpacity: 0.15,
  outlineColor: c.seeker,
  outlineWidth: 2,
  closingPointColor: c.text,
  closingPointWidth: 7,
  closingPointOutlineColor: c.bg,
  closingPointOutlineWidth: 2,
})

type Picked = { id: string; name: string; area: Area }

/**
 * Seekers shade one answer themselves when the app's shading is wrong or missing: pick areas
 * (a suburb, the question's circle) or draw them, then keep only that area or rule it out.
 * Saved with set_question_shading, so every phone shades the same way.
 */
export function ManualShadeSheet({ sync, question: q, city, playArea, ruled, layer, canAct, onClose }: Props) {
  const initial = q.manualShading
  const [mode, setMode] = useState<Mode>(initial?.mode ?? 'cut')
  const [tool, setTool] = useState<Tool>('pick')
  const [picked, setPicked] = useState<Picked[]>(() =>
    initial && initial.mode !== 'none' ? [{ id: 'saved', name: 'Saved shading', area: initial.area }] : [],
  )
  const [drawn, setDrawn] = useState<Polygon[]>([])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const drawRef = useRef<TerraDraw | null>(null)
  const mapRef = useRef<MapLibreMap | null>(null)

  const qTool = useMemo(() => questionTool(q, layer), [q, layer])
  // The question's own circles (radar, measuring, tentacles), offered as one-tap picks.
  const circles = useMemo(
    () => qTool.features.filter((f): f is Feature<Polygon> => f.geometry.type === 'Polygon'),
    [qTool],
  )

  const area = useMemo<Area | null>(() => {
    const parts: Area[] = [
      ...picked.map((p) => p.area),
      ...drawn.map((g): Area => ({ type: 'Feature', properties: {}, geometry: g })),
    ]
    try {
      return unionAll(parts)
    } catch {
      return parts[0] ?? null
    }
  }, [picked, drawn])

  const preview = useMemo<FeatureCollection>(
    () => ({
      type: 'FeatureCollection',
      features: [...qTool.features.filter((f) => f.geometry.type !== 'Polygon'), ...(area && mode !== 'none' ? [area] : [])],
    }),
    [qTool, area, mode],
  )
  const overlay = useMemo(() => ({ ruled, tool: preview }), [ruled, preview])

  const onTap = useCallback(
    (p: LngLat) => {
      if (tool !== 'pick' || !layer) return
      // The smallest pickable area under the tap (a suburb before its council area).
      let best: Picked | null = null
      let bestSize = Infinity
      for (const id of PICK_LAYERS) {
        for (const f of layer(id)) {
          const g = f.geometry
          if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon') || !booleanPointInPolygon(p, g)) continue
          const size = turfArea(g)
          if (size < bestSize) {
            bestSize = size
            best = { id: `${id}:${featureId(f)}`, name: String(f.properties?.name ?? 'Area'), area: { type: 'Feature', properties: {}, geometry: g } }
          }
        }
      }
      if (!best) return
      const hit = best
      setPicked((cur) => (cur.some((x) => x.id === hit.id) ? cur.filter((x) => x.id !== hit.id) : [...cur, hit]))
    },
    [tool, layer],
  )

  const onMapReady = useCallback((map: MapLibreMap) => {
    mapRef.current = map
    const colors = MAP_PALETTES[getMapTheme()]
    const draw = new TerraDraw({
      adapter: new TerraDrawMapLibreGLAdapter({ map }),
      modes: [new TerraDrawPolygonMode({ styles: drawStyle(colors), pointerDistance: 30 }), new TerraDrawRenderMode({ modeName: 'static', styles: {} })],
    })
    draw.start()
    draw.setMode('static')
    draw.on('finish', () => {
      setDrawn(
        draw
          .getSnapshot()
          .filter((f) => f.geometry.type === 'Polygon')
          .map((f) => f.geometry as Polygon),
      )
    })
    drawRef.current = draw
  }, [])

  useEffect(() => {
    const draw = drawRef.current
    if (!draw?.enabled) return
    draw.setMode(tool === 'draw' ? 'polygon' : 'static')
    if (mapRef.current) resetGestures(mapRef.current)
  }, [tool])

  useEffect(() => {
    document.documentElement.classList.add('scroll-locked')
    return () => {
      document.documentElement.classList.remove('scroll-locked')
      const draw = drawRef.current
      drawRef.current = null
      try {
        if (draw?.enabled) {
          draw.setMode('static')
          draw.stop()
        }
        if (mapRef.current) resetGestures(mapRef.current)
      } catch {
        // The map may already be gone.
      }
    }
  }, [])

  const clearAll = () => {
    setPicked([])
    setDrawn([])
    drawRef.current?.clear()
  }

  const points = area ? manualAreaPoints(area.geometry) : 0
  const tooBig = points > MAX_SHADING_POINTS
  const blocker =
    mode !== 'none' && !area ? (tool === 'pick' ? 'Tap an area on the map, or use the question\'s circle.' : 'Draw a shape: tap to add corners, tap the first one to close it.') : tooBig ? 'That shape is too detailed. Pick fewer areas.' : null

  const save = async (shading: { mode: Mode; area?: Polygon | MultiPolygon } | null) => {
    setBusy(true)
    setErr(null)
    try {
      await sync.action('set_question_shading', { p_question_id: q.id, p_shading: shading })
      onClose()
    } catch (e) {
      setErr(describeError(e))
    } finally {
      setBusy(false)
    }
  }

  return createPortal(
    <div className="editor" role="dialog" aria-modal="true" aria-label="Shade by hand">
      <header className="editor-bar">
        <button className="small secondary" onClick={onClose}>
          Close
        </button>
        <span className="editor-title">Shade by hand</span>
        <span />
      </header>
      <GameMap
        city={city}
        playArea={playArea}
        onReady={onMapReady}
        className="editor-map"
        tapNames={false}
        overlay={overlay}
        onTap={onTap}
        hideVenues
      />
      <section className="editor-sheet">
        <p className="small">{questionText(q)}</p>
        <div className="segmented" role="group" aria-label="What the answer means">
          {(
            [
              ['keep', 'Keep only'],
              ['cut', 'Rule out'],
              ['none', 'Nothing'],
            ] as const
          ).map(([m, label]) => (
            <button key={m} className={mode === m ? 'on' : ''} aria-pressed={mode === m} onClick={() => setMode(m)}>
              {label}
            </button>
          ))}
        </div>
        <p className="muted small-note">
          {mode === 'keep'
            ? 'The hider is inside the area you pick or draw: everything else is hatched.'
            : mode === 'cut'
              ? 'The hider is not inside the area you pick or draw: it gets hatched.'
              : 'This answer rules nothing out.'}
        </p>
        {mode !== 'none' && (
          <>
            <div className="segmented" role="group" aria-label="Tool">
              <button className={tool === 'pick' ? 'on' : ''} aria-pressed={tool === 'pick'} onClick={() => setTool('pick')}>
                Pick
              </button>
              <button className={tool === 'draw' ? 'on' : ''} aria-pressed={tool === 'draw'} onClick={() => setTool('draw')}>
                Draw
              </button>
            </div>
            <p className="muted small-note">
              {tool === 'pick'
                ? 'Tap a suburb to add or remove it.'
                : 'Tap to add corners. Tap the first corner to close the shape.'}
            </p>
            <div className="row editor-row">
              {circles.length > 0 && (
                <button
                  className="small secondary"
                  onClick={() =>
                    setPicked((cur) =>
                      cur.some((x) => x.id === 'circle')
                        ? cur.filter((x) => x.id !== 'circle')
                        : [...cur, { id: 'circle', name: 'Question circle', area: circles[0] }],
                    )
                  }
                >
                  {picked.some((x) => x.id === 'circle') ? 'Remove the circle' : "Use the question's circle"}
                </button>
              )}
              <button className="small secondary" disabled={!picked.length && !drawn.length} onClick={clearAll}>
                Clear
              </button>
            </div>
            {picked.length > 0 && <p className="muted small">Picked: {picked.map((p) => p.name).join(', ')}</p>}
          </>
        )}
        {err && <p className="bad">{err}</p>}
        <div className="editor-actions">
          <button
            className="wide"
            disabled={!canAct || busy || !!blocker}
            onClick={() => void save(mode === 'none' ? { mode } : area ? { mode, area: area.geometry } : null)}
          >
            Save shading
          </button>
          {initial && (
            <button className="wide secondary" disabled={!canAct || busy} onClick={() => void save(null)}>
              Back to the app's shading
            </button>
          )}
        </div>
        {blocker && <p className="muted small">{blocker}</p>}
      </section>
    </div>,
    document.body,
  )
}
