import type { CityPack } from '../map/cityPack'
import type { QuestionType } from '../play/questionTypes'
import type { ReplayData } from './api'
import { readZip, ZipError, type ZipEntry } from './unzip'

/** Files the download zip holds next to the media (src/replay/download.ts). */
export const SAVED = { events: 'events.json', summary: 'summary.txt', pack: 'city-pack.json', types: 'question-types.json' } as const
export const MEDIA_DIR = 'media/'

/** A downloaded game opened from its zip: everything the replay needs, without the server. */
export interface SavedGame {
  data: ReplayData
  /** Map data saved with the game (zips from before it was added: null, the map loads from the server). */
  pack: CityPack | null
  types: QuestionType[] | null
  /** Media by name (<game>/<folder>/<file>), read from the zip when shown. */
  media: Map<string, ZipEntry>
}

async function json(entry: ZipEntry | undefined): Promise<unknown> {
  if (!entry) return null
  try {
    return JSON.parse(await (await entry.blob()).text())
  } catch {
    return null
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Check events.json looks like a saved game (get_replay's shape). */
export function asReplayData(v: unknown): ReplayData | null {
  if (!isObj(v) || !isObj(v.game) || typeof v.game.id !== 'string' || !Array.isArray(v.events)) return null
  return {
    game: v.game as unknown as ReplayData['game'],
    can_delete: false,
    players: Array.isArray(v.players) ? (v.players as ReplayData['players']) : [],
    events: v.events as ReplayData['events'],
    track: Array.isArray(v.track) ? (v.track as ReplayData['track']) : [],
    media: Array.isArray(v.media) ? (v.media as ReplayData['media']) : [],
  }
}

export async function openSavedGame(file: Blob): Promise<SavedGame> {
  const entries = await readZip(file)
  const data = asReplayData(await json(entries.get(SAVED.events)))
  if (!data) throw new ZipError("That zip isn't a saved Hide + Drink game.")
  const pack = await json(entries.get(SAVED.pack))
  const types = await json(entries.get(SAVED.types))
  const media = new Map<string, ZipEntry>()
  for (const [name, entry] of entries) if (name.startsWith(MEDIA_DIR)) media.set(name.slice(MEDIA_DIR.length), entry)
  return {
    data,
    pack: isObj(pack) && Array.isArray(pack.features) && isObj(pack.pack) ? (pack as unknown as CityPack) : null,
    types: Array.isArray(types) ? (types as QuestionType[]) : null,
    media,
  }
}
