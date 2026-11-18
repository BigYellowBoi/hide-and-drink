import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

describe('reloadForNewVersion', () => {
  const store = new Map<string, string>()
  const reload = vi.fn()
  beforeEach(() => {
    vi.resetModules()
    store.clear()
    reload.mockClear()
    vi.stubGlobal('sessionStorage', {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    })
    vi.stubGlobal('location', { reload })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('reloads once, then not again within 30 s', async () => {
    const { reloadForNewVersion } = await import('./reloadOnStale')
    expect(reloadForNewVersion(1_000_000)).toBe(true)
    expect(reloadForNewVersion(1_010_000)).toBe(false)
    expect(reloadForNewVersion(1_040_000)).toBe(true)
    expect(reload).toHaveBeenCalledTimes(2)
  })

  it('a missing chunk reloads instead of throwing', async () => {
    let loader: (() => Promise<unknown>) | null = null
    // Capture what React.lazy would call.
    vi.doMock('react', async (orig) => ({ ...(await orig<typeof import('react')>()), lazy: (f: () => Promise<unknown>) => (loader = f) }))
    vi.resetModules()
    const mod = await import('./reloadOnStale')
    mod.lazyWithReload<() => null>(() => Promise.reject(new TypeError('Importing a module script failed.')))
    const settled = await Promise.race([loader!().then(() => 'resolved', () => 'threw'), new Promise((r) => setTimeout(() => r('pending'), 20))])
    expect(settled).toBe('pending')
    expect(reload).toHaveBeenCalledTimes(1)
  })
})
