/** localStorage that never throws (private mode, blocked storage): values just don't persist. */
export function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

export function writeLocal(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // ignore
  }
}

export const GAME_KEY = 'hd.gameId'
export const NAME_KEY = 'hd.name'

/** The join code of the last game this phone was in, so it can rejoin after losing its session. */
export const LAST_CODE_KEY = 'hd.lastCode'
