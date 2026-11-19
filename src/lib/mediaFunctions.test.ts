import { describe, expect, it } from 'vitest'
import {
  cleanPicked,
  DEFAULT_LIMITS,
  errorCode,
  gameFolder,
  isMediaName,
  mediaLimits,
  objectUrl,
  parseListKeys,
  pinMatches,
  r2Config,
  R2_FREE_BYTES,
} from '../../supabase/functions/_shared/media'

// The Edge Functions' shared helpers (supabase/functions/_shared/media.ts, docs/r2.md).

const env = (vars: Record<string, string>) => (k: string) => vars[k]
const SECRETS = { R2_ACCOUNT_ID: 'acc', R2_ACCESS_KEY_ID: 'id', R2_SECRET_ACCESS_KEY: 'secret', R2_BUCKET: 'hide-and-drink-media' }
const G = '11111111-1111-4111-8111-111111111111'

describe('media functions', () => {
  it('need all four R2 secrets, else the app uses Supabase', () => {
    expect(r2Config(env(SECRETS))).toEqual({ accountId: 'acc', accessKeyId: 'id', secretAccessKey: 'secret', bucket: 'hide-and-drink-media' })
    expect(r2Config(env({ ...SECRETS, R2_BUCKET: '' }))).toBeNull()
  })

  it('keep the budget under the free 10 GB whatever the settings say', () => {
    expect(mediaLimits(env({}))).toEqual(DEFAULT_LIMITS)
    expect(DEFAULT_LIMITS.budgetBytes).toBeLessThan(R2_FREE_BYTES)
    expect(mediaLimits(env({ R2_BUDGET_BYTES: '50000000000' })).budgetBytes).toBeLessThan(R2_FREE_BYTES)
    expect(mediaLimits(env({ R2_BUDGET_BYTES: 'lots' })).budgetBytes).toBe(DEFAULT_LIMITS.budgetBytes)
    expect(mediaLimits(env({ R2_REDUCED_SHARE: '0.3' })).reducedShare).toBe(0.3)
  })

  it('accept only <game>/<folder>/<file>.<ext> names', () => {
    expect(isMediaName(`${G}/${G}/abc-1.mov`)).toBe(true)
    expect(isMediaName(`${G}/${G}/../x.mov`)).toBe(false)
    expect(isMediaName(`${G}/${G}/x.exe`)).toBe(false)
    expect(isMediaName(`${G}/x.jpg`)).toBe(false)
  })

  it('address the object in the bucket', () => {
    expect(objectUrl(r2Config(env(SECRETS))!, `${G}/${G}/a.jpg`)).toBe(`https://acc.r2.cloudflarestorage.com/hide-and-drink-media/${G}/${G}/a.jpg`)
  })

  it('keep only known picker fields', () => {
    expect(cleanPicked({ bytes: 12.4, type: 'video/quicktime', evil: 'x', squeezed: 'yes' })).toEqual({ bytes: 12, type: 'video/quicktime' })
    expect(cleanPicked(null)).toEqual({})
  })

  it('pass on snake_case error codes only', () => {
    expect(errorCode('media_not_allowed')).toBe('media_not_allowed')
    expect(errorCode('relation "x" does not exist')).toBe('media_error')
  })
})

describe('delete-game and admin-pin helpers', () => {
  it('reads R2 list pages', () => {
    const xml = `<ListBucketResult><IsTruncated>true</IsTruncated><Contents><Key>${G}/a/b.jpg</Key></Contents><Contents><Key>${G}/c/d&amp;e.mp4</Key></Contents><NextContinuationToken>tok==</NextContinuationToken></ListBucketResult>`
    expect(parseListKeys(xml)).toEqual({ keys: [`${G}/a/b.jpg`, `${G}/c/d&e.mp4`], next: 'tok==' })
    expect(parseListKeys('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>')).toEqual({ keys: [], next: null })
  })
  it('only takes a game id as the folder to delete', () => {
    expect(gameFolder(G)).toBe(`${G}/`)
    expect(gameFolder('')).toBeNull()
    expect(gameFolder('../x')).toBeNull()
    expect(gameFolder(`${G}/x`)).toBeNull()
  })
  it('matches the PIN exactly, never without a secret', () => {
    expect(pinMatches('4821', '4821')).toBe(true)
    expect(pinMatches(' 4821 ', '4821\n')).toBe(true)
    expect(pinMatches('4822', '4821')).toBe(false)
    expect(pinMatches('482', '4821')).toBe(false)
    expect(pinMatches('48210', '4821')).toBe(false)
    expect(pinMatches('', '')).toBe(false)
    expect(pinMatches('1234', undefined)).toBe(false)
    expect(pinMatches(1234, '1234')).toBe(false)
  })
})
