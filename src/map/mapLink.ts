import type { Feature, FeatureCollection, MultiPolygon, Polygon } from 'geojson'

/**
 * Import a play area from a Hide and Seek Map Generator (taibeled/JetLagHideAndSeek) share link.
 *
 * Link formats the generator writes (query parameters on its page URL):
 * - `hzc`: base64url of deflate (zlib) compressed JSON. Current format.
 * - `hz`: plain base64 JSON. Legacy.
 * - `pb`: a Pastebin paste id holding the JSON.
 * - `url`: any URL holding the JSON.
 * The JSON is either a FeatureCollection of the drawn polygons (plus `questions` and settings),
 * or a single OSM place Feature with `properties.isHidingZone` (a named boundary, no polygon).
 * Only the polygons are imported; questions, stations and settings are ignored.
 * Pasting the raw JSON (the generator's "copy" option) works too.
 */

export type AreaCollection = FeatureCollection<Polygon | MultiPolygon>

export interface ImportedArea {
  area: AreaCollection
  /** Short description of where it came from, stored with the saved area. */
  source: string
  /** Suggested name, if the link carried one. */
  name: string | null
  /** Things the import ignored, for the host to know. */
  notes: string[]
}

export class MapLinkError extends Error {}

type Fetcher = (url: string) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>

const fromBase64 = (b64: string): Uint8Array => {
  const std = b64.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '')
  const padded = std + '='.repeat((4 - (std.length % 4)) % 4)
  const bin = atob(padded)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function inflate(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new TextDecoder().decode(await new Response(stream).arrayBuffer())
}

/** Encode JSON the way the generator does (used by tests and to round-trip). */
export async function encodeHzc(json: string): Promise<string> {
  const stream = new Blob([new TextEncoder().encode(json) as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function parseUrl(input: string): URL | null {
  for (const candidate of [input, `https://${input}`]) {
    try {
      const u = new URL(candidate)
      if (u.search || u.hash) return u
    } catch {
      // not a URL
    }
  }
  return null
}

async function fetchText(fetcher: Fetcher, url: string, what: string): Promise<string> {
  let res
  try {
    res = await fetcher(url)
  } catch {
    throw new MapLinkError(`Couldn't download the ${what}. Open the link in the generator, then share it again without Pastebin.`)
  }
  if (!res.ok) throw new MapLinkError(`Couldn't download the ${what} (HTTP ${res.status}).`)
  return res.text()
}

/** Turn the link (or pasted JSON) into the generator's JSON text. */
async function linkJson(input: string, fetcher: Fetcher): Promise<{ json: string; via: string }> {
  const text = input.trim()
  if (!text) throw new MapLinkError('Paste a link first.')
  if (text.startsWith('{')) return { json: text, via: 'pasted JSON' }

  const url = parseUrl(text)
  if (!url) throw new MapLinkError("That doesn't look like a Map Generator link.")
  // Some share paths put the query after a hash; accept both.
  const params = new URLSearchParams(url.search || url.hash.replace(/^#\/?\??/, ''))

  try {
    const hzc = params.get('hzc')
    if (hzc) return { json: await inflate(fromBase64(hzc)), via: 'link' }
    const hz = params.get('hz')
    if (hz) return { json: new TextDecoder().decode(fromBase64(hz)), via: 'link' }
  } catch {
    throw new MapLinkError('The link is damaged or cut off. Copy it again from the generator.')
  }
  const pb = params.get('pb')
  if (pb) {
    if (!/^[A-Za-z0-9]+$/.test(pb)) throw new MapLinkError('That Pastebin id looks wrong.')
    return { json: await fetchText(fetcher, `https://pastebin.com/raw/${pb}`, 'Pastebin paste'), via: 'Pastebin link' }
  }
  const remote = params.get('url')
  if (remote) {
    if (!/^https:\/\//i.test(remote)) throw new MapLinkError('Only https links can be downloaded.')
    return { json: await fetchText(fetcher, remote, 'linked file'), via: 'linked file' }
  }
  throw new MapLinkError("That link has no map in it. In the generator, use Share and copy the link it gives you.")
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const isPolygonal = (g: unknown): g is Polygon | MultiPolygon =>
  isObj(g) && (g.type === 'Polygon' || g.type === 'MultiPolygon') && Array.isArray(g.coordinates)

/** Pull the polygons out of the generator's JSON. Exported for tests. */
export function areaFromJson(data: unknown): Omit<ImportedArea, 'source'> {
  if (!isObj(data)) throw new MapLinkError('The link holds no map data.')
  const notes: string[] = []
  const props = isObj(data.properties) ? data.properties : {}

  if (props.isHidingZone === true) {
    const place = typeof props.name === 'string' ? props.name : 'a named place'
    throw new MapLinkError(
      `That link uses the boundary of ${place} from OpenStreetMap, not a drawn area, so it has no polygon to import. In the generator, draw the area (or "Draw boundary") and share again, or draw it here.`,
    )
  }

  const raw: unknown[] =
    data.type === 'FeatureCollection' && Array.isArray(data.features)
      ? data.features
      : data.type === 'Feature'
        ? [data]
        : isPolygonal(data)
          ? [{ type: 'Feature', properties: {}, geometry: data }]
          : []
  const features: Feature<Polygon | MultiPolygon>[] = []
  for (const f of raw) {
    if (isObj(f) && isPolygonal(f.geometry)) {
      features.push({ type: 'Feature', properties: {}, geometry: f.geometry })
    }
  }
  if (features.length === 0) throw new MapLinkError('The link has no drawn area in it.')
  if (raw.length > features.length) notes.push(`${raw.length - features.length} non-area shapes skipped.`)

  if (Array.isArray(data.questions) && data.questions.length > 0) {
    notes.push(`${data.questions.length} question${data.questions.length === 1 ? '' : 's'} in the link ignored.`)
  }
  if (typeof data.hidingRadius === 'number') {
    const units = typeof data.hidingRadiusUnits === 'string' ? ` ${data.hidingRadiusUnits}` : ''
    notes.push(`Hiding radius (${data.hidingRadius}${units}) ignored: set it in game settings.`)
  }
  const name = typeof props.name === 'string' && props.name.trim() ? props.name.trim().slice(0, 80) : null
  return { area: { type: 'FeatureCollection', features }, name, notes }
}

export async function importMapLink(input: string, fetcher: Fetcher = (u) => fetch(u)): Promise<ImportedArea> {
  const { json, via } = await linkJson(input, fetcher)
  let data: unknown
  try {
    data = JSON.parse(json)
  } catch {
    throw new MapLinkError('The link is damaged or cut off. Copy it again from the generator.')
  }
  return { ...areaFromJson(data), source: `Hide and Seek Map Generator (${via})` }
}
