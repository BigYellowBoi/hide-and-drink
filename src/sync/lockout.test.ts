import { describe, expect, it } from 'vitest'
import { bannerDelayMs, formatStaleFor, lockoutFor } from './lockout'

describe('stale-state lockout', () => {
  it('has no banner while live, idle or in error', () => {
    expect(lockoutFor('live', null, 0)).toBeNull()
    expect(lockoutFor('idle', null, 0)).toBeNull()
    expect(lockoutFor('error', 1000, 5000)).toBeNull()
  })

  it('locks while offline, connecting or syncing', () => {
    expect(lockoutFor('offline', null, 0)?.title).toBe('No connection')
    expect(lockoutFor('connecting', null, 0)?.title).toBe('Reconnecting…')
    expect(lockoutFor('syncing', null, 0)?.title).toBe('Catching up…')
  })

  it('says how long the view has been out of date', () => {
    expect(lockoutFor('offline', 10_000, 75_500)?.staleForS).toBe(65)
    expect(lockoutFor('offline', null, 75_500)?.staleForS).toBeNull()
    expect(formatStaleFor(9)).toBe('9 s')
    expect(formatStaleFor(65)).toBe('1 min 05 s')
  })

  it('shows offline at once but delays brief syncs', () => {
    expect(bannerDelayMs('offline')).toBe(0)
    expect(bannerDelayMs('syncing')).toBeGreaterThan(0)
  })
})
