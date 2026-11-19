import { createContext } from 'react'
import type { ZipEntry } from './unzip'

/**
 * Where PhotoThumb gets a photo or video URL. null (the default): from the server
 * (media-read-url). A saved game opened from its zip provides the files in the zip instead.
 */
export const MediaSourceContext = createContext<((path: string) => Promise<string>) | null>(null)

const TYPES: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
}

/** Object URLs for media in a saved game's zip, made once per file. revoke() frees them all. */
export function zipMediaSource(media: ReadonlyMap<string, ZipEntry>) {
  const urls = new Map<string, Promise<string>>()
  const get = (path: string) => {
    let url = urls.get(path)
    if (!url) {
      const entry = media.get(path)
      if (!entry) return Promise.reject(new Error('Not in this saved game'))
      const type = TYPES[path.split('.').pop()?.toLowerCase() ?? ''] ?? ''
      url = entry.blob().then((b) => URL.createObjectURL(new Blob([b], { type })))
      urls.set(path, url)
    }
    return url
  }
  const revoke = () => {
    for (const u of urls.values()) void u.then(URL.revokeObjectURL, () => {})
    urls.clear()
  }
  return { get, revoke }
}
