import { describe, expect, it } from 'vitest'

// Supabase keys applied migrations by the timestamp prefix. Two files with the same prefix
// (easy when two PRs are built in parallel) make the second one fail to deploy.
const files = Object.keys(import.meta.glob('../../supabase/migrations/*.sql')).map((p) => p.split('/').pop()!)

describe('supabase migrations', () => {
  it('are found', () => {
    expect(files.length).toBeGreaterThan(10)
  })

  it('each have a unique version', () => {
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const f of files) {
      const version = f.split('_')[0]
      const other = seen.get(version)
      if (other) clashes.push(`${other} and ${f}`)
      seen.set(version, f)
    }
    expect(clashes).toEqual([])
  })
})
