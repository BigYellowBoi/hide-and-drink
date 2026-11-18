import { lazyWithReload } from '../lib/reloadOnStale'

// MapLibre and Terra Draw are large: load them only when a map is on screen.
export const LazyGameMap = lazyWithReload(() => import('./GameMap').then((m) => ({ default: m.GameMap })))
export const LazyPlayAreaEditor = lazyWithReload(() =>
  import('./PlayAreaEditor').then((m) => ({ default: m.PlayAreaEditor })),
)
