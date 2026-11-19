import { describe, expect, it } from 'vitest'
import { buildLabel } from './version'

describe('buildLabel', () => {
  it('shows the build number and short commit', () => {
    expect(buildLabel({ VITE_BUILD_NUMBER: '54', VITE_BUILD_SHA: '4ff6be618630bca2' })).toBe('v54 · 4ff6be6')
    expect(buildLabel({ VITE_BUILD_NUMBER: '54' })).toBe('v54')
    expect(buildLabel({ VITE_BUILD_SHA: 'abcdef123' })).toBe('Build abcdef1')
    expect(buildLabel({})).toBe('Local build')
  })
})
