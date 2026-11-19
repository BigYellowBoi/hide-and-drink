import { FunctionsFetchError, FunctionsHttpError, type SupabaseClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MediaError, PutError, mediaName, photoType, retryable, uploadMedia, withRetry, type UploadProgress } from './media'

vi.mock('./photos', async (orig) => ({
  ...(await orig<typeof import('./photos')>()),
  shrinkPhoto: vi.fn(async () => new Blob(['small'], { type: 'image/jpeg' })),
  squeezeVideo: vi.fn(async (_b: Blob, onProgress: (d: number, t: number) => void) => {
    onProgress(5, 10)
    return new Blob(['tiny'], { type: 'video/mp4' })
  }),
}))

const GAME = '11111111-1111-4111-8111-111111111111'
const FOLDER = '22222222-2222-4222-8222-222222222222'
const target = { gameId: GAME, folderId: FOLDER, bucket: 'drink-photos' }

/** XMLHttpRequest stand-in: each send() takes the next status from `statuses` (default 200). */
let statuses: number[] = []
let puts: { url: string; type: string | null; size: number }[] = []
class FakeXhr {
  status = 0
  upload: { onprogress: ((e: { loaded: number; total: number; lengthComputable: boolean }) => void) | null } = { onprogress: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  ontimeout: (() => void) | null = null
  private url = ''
  private type: string | null = null
  open(_m: string, url: string) {
    this.url = url
  }
  setRequestHeader(k: string, v: string) {
    if (k === 'Content-Type') this.type = v
  }
  send(blob: Blob) {
    puts.push({ url: this.url, type: this.type, size: blob.size })
    const s = statuses.shift() ?? 200
    queueMicrotask(() => {
      if (s === 0) return this.onerror?.()
      this.upload.onprogress?.({ loaded: blob.size, total: blob.size, lengthComputable: true })
      this.status = s
      this.onload?.()
    })
  }
}

type Invoke = (fn: string, body: Record<string, unknown>) => { data?: unknown; error?: unknown }
function fakeClient(invoke: Invoke) {
  const calls: { fn: string; body: Record<string, unknown> }[] = []
  const uploads: { bucket: string; path: string; type: string }[] = []
  const client = {
    functions: {
      invoke: async (fn: string, opts: { body: Record<string, unknown> }) => {
        calls.push({ fn, body: opts.body })
        const r = invoke(fn, opts.body)
        return { data: r.data ?? null, error: r.error ?? null }
      },
    },
    storage: {
      from: (bucket: string) => ({
        upload: async (path: string, _b: Blob, o: { contentType: string }) => {
          uploads.push({ bucket, path, type: o.contentType })
          return { error: null }
        },
      }),
    },
  } as unknown as SupabaseClient
  return { client, calls, uploads }
}

const httpError = (status: number, body: unknown) =>
  new FunctionsHttpError(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))

const r2Grant = (n: number) => ({ data: { store: 'r2', url: `https://r2.example/put/${n}`, bucket: 'drink-photos', quality: 'original' } })
const noWait = [0, 0, 0]

beforeEach(() => {
  statuses = []
  puts = []
  vi.stubGlobal('XMLHttpRequest', FakeXhr)
})
afterEach(() => vi.unstubAllGlobals())

describe('helpers', () => {
  it('keeps jpeg, png and webp photos as they are', () => {
    expect(photoType(new Blob([], { type: 'image/jpeg' }))).toEqual({ contentType: 'image/jpeg', ext: 'jpg' })
    expect(photoType(new Blob([], { type: 'image/png' }))?.ext).toBe('png')
    expect(photoType(new Blob([], { type: 'image/heic' }))).toBeNull()
  })

  it('names files <game>/<folder>/<id>.<ext>', () => {
    expect(mediaName(GAME, FOLDER, 'mov', 'ab-c/d')).toBe(`${GAME}/${FOLDER}/ab-cd.mov`)
  })

  it('retries network trouble, expired URLs and server errors, not refusals', () => {
    expect(retryable(new PutError(0))).toBe(true)
    expect(retryable(new PutError(403))).toBe(true)
    expect(retryable(new PutError(503))).toBe(true)
    expect(retryable(new PutError(400))).toBe(false)
    expect(retryable(new MediaError('media_not_allowed'))).toBe(false)
  })

  it('withRetry gives up after the last delay', async () => {
    const waits: number[] = []
    let n = 0
    await expect(
      withRetry(
        async () => {
          n++
          throw new PutError(0)
        },
        retryable,
        [1, 2],
        async (ms) => void waits.push(ms),
      ),
    ).rejects.toBeInstanceOf(PutError)
    expect(n).toBe(3)
    expect(waits).toEqual([1, 2])
  })

  it('refusals read as messages', () => {
    expect(new MediaError('media_not_allowed').message).toMatch(/no longer send/)
  })
})

describe('uploadMedia', () => {
  it('sends the original video to R2 untouched, then confirms', async () => {
    const big = new File([new Uint8Array(60 * 1024 * 1024)], 'IMG_0001.MOV', { type: 'video/quicktime' })
    const { client, calls, uploads } = fakeClient((_fn, body) => (body.done ? { data: { ok: true } } : r2Grant(1)))
    const progress: UploadProgress[] = []
    const name = await uploadMedia(client, target, big, (p) => progress.push(p), noWait)

    expect(name).toMatch(new RegExp(`^${GAME}/${FOLDER}/[A-Za-z0-9_-]+\\.mov$`))
    expect(puts).toEqual([{ url: 'https://r2.example/put/1', type: 'video/quicktime', size: big.size }])
    expect(uploads).toEqual([])
    expect(calls[0].body).toMatchObject({
      name,
      bytes: big.size,
      content_type: 'video/quicktime',
      picked: { bytes: big.size, type: 'video/quicktime', name: 'IMG_0001.MOV' },
    })
    expect(calls[1].body).toEqual({ name, done: true })
    expect(progress.some((p) => p.fraction === 1 && /Uploading video 100%/.test(p.label))).toBe(true)
  })

  it('retries a failed PUT with a fresh URL', async () => {
    statuses = [0, 503, 200]
    let n = 0
    const { client } = fakeClient((_fn, body) => (body.done ? { data: { ok: true } } : r2Grant(++n)))
    await uploadMedia(client, target, new Blob(['p'], { type: 'image/jpeg' }), () => {}, noWait)
    expect(puts.map((p) => p.url)).toEqual(['https://r2.example/put/1', 'https://r2.example/put/2', 'https://r2.example/put/3'])
  })

  it('squeezes a reduced-quality video when asked, then sends the squeezed copy to R2', async () => {
    const { client, calls } = fakeClient((_fn, body) =>
      body.done ? { data: { ok: true } } : body.picked && (body.picked as { squeezed?: boolean }).squeezed ? r2Grant(1) : { data: { squeeze: true } },
    )
    const name = await uploadMedia(client, target, new Blob(['bird'.repeat(100)], { type: 'video/mp4' }), () => {}, noWait)
    expect(name.endsWith('.mp4')).toBe(true)
    expect(puts).toHaveLength(1)
    expect(puts[0].size).toBe(4)
    expect(calls.filter((c) => !c.body.done).map((c) => (c.body.picked as { squeezed?: boolean }).squeezed ?? false)).toEqual([false, true])
  })

  it('falls back to the Supabase bucket when the function is not set up', async () => {
    const { client, uploads } = fakeClient(() => ({ data: { store: 'supabase', reason: 'r2_not_configured' } }))
    const name = await uploadMedia(client, target, new Blob(['p'], { type: 'image/png' }), () => {}, noWait)
    expect(puts).toEqual([])
    expect(uploads).toEqual([{ bucket: 'drink-photos', path: name, type: 'image/jpeg' }])
    expect(name.endsWith('.jpg')).toBe(true)
  })

  it('falls back when the function cannot be reached', async () => {
    const { client, uploads } = fakeClient(() => ({ error: new FunctionsFetchError({}) }))
    await uploadMedia(client, target, new Blob(['v'], { type: 'video/mp4' }), () => {}, noWait)
    expect(uploads[0]).toMatchObject({ bucket: 'drink-photos', type: 'video/mp4' })
  })

  it('stops on a refusal: no retry, no fallback', async () => {
    const { client, uploads } = fakeClient(() => ({ error: httpError(400, { error: 'media_not_allowed' }) }))
    await expect(uploadMedia(client, target, new Blob(['p'], { type: 'image/jpeg' }), () => {}, noWait)).rejects.toMatchObject({
      code: 'media_not_allowed',
    })
    expect(puts).toEqual([])
    expect(uploads).toEqual([])
  })

  it('refuses photos past the sanity cap before asking', async () => {
    const huge = { size: 2_000_000_001, type: 'image/jpeg' } as Blob
    const { client, calls } = fakeClient(() => r2Grant(1))
    await expect(uploadMedia(client, target, huge, () => {}, noWait)).rejects.toMatchObject({ code: 'media_too_big' })
    expect(calls).toEqual([])
  })

  it('asks about videos past the cap, so a reduced-quality one can be squeezed', async () => {
    const huge = { size: 2_000_000_001, type: 'video/mp4' } as Blob
    const { client } = fakeClient((_fn, body) =>
      body.done ? { data: { ok: true } } : (body.picked as { squeezed?: boolean }).squeezed ? r2Grant(1) : { data: { squeeze: true } },
    )
    await uploadMedia(client, target, huge, () => {}, noWait)
    expect(puts[0].size).toBe(4)
  })

  it('shows the refusal for a full-quality video past the cap', async () => {
    const huge = { size: 2_000_000_001, type: 'video/mp4' } as Blob
    const { client } = fakeClient(() => ({ error: httpError(400, { error: 'media_too_big' }) }))
    await expect(uploadMedia(client, target, huge, () => {}, noWait)).rejects.toThrow(/4K 30 fps/)
  })
})
