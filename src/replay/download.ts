import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadZip } from 'client-zip'
import { photoUrl } from '../play/photos'
import type { ReplayData } from './api'
import { buildReplay } from './state'
import { gameSummary, zipMediaPath } from './summary'
import { SAVED } from './saved'
import { loadCityPack } from '../map/cityPack'
import { loadQuestionTypes } from '../play/questionTypes'

export interface DownloadProgress {
  done: number
  total: number
}

/** The zip's file name: hide-and-drink-2026-11-21-ABCD.zip */
export function zipName(data: ReplayData): string {
  const at = Date.parse(data.game.ended_at ?? data.game.created_at)
  const day = Number.isNaN(at) ? 'game' : new Date(at).toISOString().slice(0, 10)
  return `hide-and-drink-${day}-${data.game.code}.zip`
}

/** events.json: everything get_replay returned, as is. */
export const eventsJson = (data: ReplayData) =>
  JSON.stringify({ exported_at: new Date().toISOString(), ...data }, null, 2)

/**
 * One zip with the event history (events.json), a readable summary (summary.txt), the map data
 * and question types (so Open a saved game needs no server) and every photo and video as stored
 * (R2 originals, older files from the Supabase buckets). Files are fetched one at a time while
 * the zip is written, so read URLs don't expire on a big game.
 */
export async function downloadGameZip(
  client: SupabaseClient,
  data: ReplayData,
  onProgress: (p: DownloadProgress) => void = () => {},
): Promise<void> {
  const total = data.media.length
  let done = 0
  const missing: string[] = []
  async function* files() {
    yield { name: SAVED.events, input: eventsJson(data) }
    yield { name: SAVED.summary, input: gameSummary(data, buildReplay(data.events)) }
    // The map and question types, so Open a saved game plays it back without the server.
    const pack = await loadCityPack(client, data.game.city).catch(() => null)
    if (pack) yield { name: SAVED.pack, input: JSON.stringify(pack) }
    const types = await loadQuestionTypes(client, data.game.city).catch(() => null)
    if (types) yield { name: SAVED.types, input: JSON.stringify(types) }
    for (const m of data.media) {
      try {
        const res = await fetch(await photoUrl(client, m.name, m.bucket))
        if (!res.ok || !res.body) throw new Error(String(res.status))
        yield { name: zipMediaPath(m.name), input: res, size: m.bytes ?? undefined }
      } catch {
        missing.push(m.name)
      }
      onProgress({ done: ++done, total })
    }
    if (missing.length) yield { name: 'missing.txt', input: `Could not download:\n${missing.join('\n')}\n` }
  }
  onProgress({ done, total })
  const zip = downloadZip(files())
  const name = zipName(data)

  // Stream straight to disk where the browser lets us choose a file (desktop Chrome, Edge).
  const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker
  if (picker && zip.body) {
    let handle: FileSystemFileHandle | null = null
    try {
      handle = await picker({ suggestedName: name, types: [{ description: 'Zip', accept: { 'application/zip': ['.zip'] } }] })
    } catch (e) {
      if ((e as Error).name === 'AbortError') return
    }
    if (handle) {
      await zip.body.pipeTo(await handle.createWritable())
      return
    }
  }
  const blob = await zip.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
