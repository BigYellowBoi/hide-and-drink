/** Incrementing build number (commit count, see vite.config.ts) and short commit, e.g. "v54 · 4ff6be6". */
interface BuildEnv {
  VITE_BUILD_NUMBER?: string
  VITE_BUILD_SHA?: string
}

export function buildLabel(env: BuildEnv = import.meta.env as BuildEnv): string {
  const n = env.VITE_BUILD_NUMBER?.trim()
  const sha = env.VITE_BUILD_SHA?.trim().slice(0, 7)
  if (!n) return sha ? `Build ${sha}` : 'Local build'
  return sha ? `v${n} · ${sha}` : `v${n}`
}
