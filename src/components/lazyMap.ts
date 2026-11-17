import { lazy } from 'react'

// MapLibre and Terra Draw are large: load them only when a map is on screen.
export const LazyGameMap = lazy(() => import('./GameMap').then((m) => ({ default: m.GameMap })))
export const LazyPlayAreaEditor = lazy(() => import('./PlayAreaEditor').then((m) => ({ default: m.PlayAreaEditor })))
