import { describe, expect, it } from 'vitest'
import { downloadZip } from 'client-zip'
import { openSavedGame, asReplayData } from './saved'
import { readZip } from './unzip'
import { eventsJson } from './download'
import type { ReplayData } from './api'

const G = '11111111-1111-4111-8111-111111111111'
const data: ReplayData = {
  game: { id: G, code: 'ABCD', city: 'brisbane', host_id: 's', created_at: '2026-12-01T09:00:00Z', ended_at: '2026-12-01T10:15:00Z' },
  can_delete: true,
  players: [{ user_id: 's', name: 'Sam', team: 'seekers', is_host: true }],
  events: [{ game_id: G, seq: 1, type: 'game_created', visibility: 'all', actor_id: null, payload: {}, created_at: '2026-12-01T09:00:00Z' }],
  track: [{ user_id: 's', round: 1, team: 'seekers', lng: 153, lat: -27.4, accuracy_m: 5, at: '2026-12-01T09:31:00Z' }],
  media: [{ name: `${G}/f/a.jpg`, store: 'r2', bucket: 'drink-photos', bytes: 3, content_type: 'image/jpeg' }],
}
const pack = { type: 'FeatureCollection', pack: { city: 'brisbane', label: 'Brisbane', extent: { type: 'Point', coordinates: [153, -27] } }, features: [] }

const zip = (files: { name: string; input: string | Uint8Array }[]) => downloadZip(files).blob()

describe('saved games', () => {
  it('opens a downloaded zip: events, map data, question types and media', async () => {
    const blob = await zip([
      { name: 'events.json', input: eventsJson(data) },
      { name: 'summary.txt', input: 'hello' },
      { name: 'city-pack.json', input: JSON.stringify(pack) },
      { name: 'question-types.json', input: JSON.stringify([{ type: 'radar' }]) },
      { name: `media/${G}/f/a.jpg`, input: new Uint8Array([1, 2, 3]) },
    ])
    const saved = await openSavedGame(blob)
    expect(saved.data.game.code).toBe('ABCD')
    expect(saved.data.events).toHaveLength(1)
    expect(saved.data.track).toHaveLength(1)
    expect(saved.data.can_delete).toBe(false)
    expect(saved.pack?.pack.city).toBe('brisbane')
    expect(saved.types?.[0].type).toBe('radar')
    const photo = saved.media.get(`${G}/f/a.jpg`)
    expect(photo?.size).toBe(3)
    expect([...new Uint8Array(await (await photo!.blob()).arrayBuffer())]).toEqual([1, 2, 3])
  })

  it('opens older zips without map data (the map then loads from the server)', async () => {
    const saved = await openSavedGame(await zip([{ name: 'events.json', input: eventsJson(data) }]))
    expect(saved.pack).toBeNull()
    expect(saved.types).toBeNull()
    expect(saved.media.size).toBe(0)
  })

  it('refuses anything else', async () => {
    await expect(openSavedGame(new Blob(['not a zip']))).rejects.toThrow('Not a zip file.')
    await expect(openSavedGame(await zip([{ name: 'x.txt', input: 'x' }]))).rejects.toThrow("isn't a saved Hide + Drink game")
    expect(asReplayData({ game: {}, events: [] })).toBeNull()
  })

  it('reads deflated entries (a re-zipped saved game)', async () => {
    // A one-file zip with a deflated entry, written by hand.
    const text = new TextEncoder().encode('hello hello hello')
    const deflated = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    const name = new TextEncoder().encode('a.txt')
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(8, 8, true)
    local.setUint32(18, deflated.length, true)
    local.setUint32(22, text.length, true)
    local.setUint16(26, name.length, true)
    const central = new DataView(new ArrayBuffer(46))
    central.setUint32(0, 0x02014b50, true)
    central.setUint16(10, 8, true)
    central.setUint32(20, deflated.length, true)
    central.setUint32(24, text.length, true)
    central.setUint16(28, name.length, true)
    const cdOffset = 30 + name.length + deflated.length
    const end = new DataView(new ArrayBuffer(22))
    end.setUint32(0, 0x06054b50, true)
    end.setUint16(8, 1, true)
    end.setUint16(10, 1, true)
    end.setUint32(12, 46 + name.length, true)
    end.setUint32(16, cdOffset, true)
    const file = new Blob([local, name, deflated, central, name, end])
    const entries = await readZip(file)
    expect(await (await entries.get('a.txt')!.blob()).text()).toBe('hello hello hello')
  })
})
