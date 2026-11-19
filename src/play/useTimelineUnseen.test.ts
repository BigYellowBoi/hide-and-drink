import { describe, expect, it } from 'vitest'
import { latestOthers } from './useTimelineUnseen'

describe('latestOthers', () => {
  it('is the newest entry someone else caused', () => {
    const log = [
      { seq: 3, by: 'them' },
      { seq: 7, by: 'me' },
      { seq: 5 },
    ]
    expect(latestOthers(log, 'me')).toBe(5)
    expect(latestOthers(log, null)).toBe(7)
    expect(latestOthers([], 'me')).toBe(0)
  })
})
