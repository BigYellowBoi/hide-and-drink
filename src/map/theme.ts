import { useSyncExternalStore } from 'react'
import { readLocal, writeLocal } from '../lib/storage'

/** Map colour scheme, per phone. The app itself stays dark; only the map goes light (sunlight). */
export type MapTheme = 'dark' | 'light'

export const MAP_THEME_KEY = 'hd.mapTheme'

const listeners = new Set<() => void>()
let current: MapTheme = readLocal(MAP_THEME_KEY) === 'light' ? 'light' : 'dark'

export function getMapTheme(): MapTheme {
  return current
}

export function setMapTheme(theme: MapTheme): void {
  if (theme === current) return
  current = theme
  writeLocal(MAP_THEME_KEY, theme)
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

/** The phone's map theme; every open map follows a change. */
export function useMapTheme(): MapTheme {
  return useSyncExternalStore(subscribe, getMapTheme, getMapTheme)
}
