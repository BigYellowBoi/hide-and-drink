import { describe, expect, it } from 'vitest'
import { presenceOf } from './presence'

describe('presenceOf', () => {
  it('reports who is present while live', () => {
    const p = presenceOf(['a'], true)
    expect(p('a')).toBe(true)
    expect(p('b')).toBe(false)
  })

  it('is unknown while not live', () => {
    expect(presenceOf(['a'], false)('a')).toBeNull()
  })
})
