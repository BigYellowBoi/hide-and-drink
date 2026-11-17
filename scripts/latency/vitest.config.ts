import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Separate from `npm test`: the harness needs a running Supabase stack.
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  test: {
    include: ['scripts/latency/*.latency.ts'],
    environment: 'node',
    // Print the results table even when the run passes.
    silent: false,
    testTimeout: 180_000,
    hookTimeout: 30_000,
  },
})
