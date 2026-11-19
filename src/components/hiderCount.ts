import { createContext } from 'react'

/** How many hiders are playing this round (Round provides it) for "Only your team sees this". */
export const HiderCountContext = createContext(1)

/** Who a hider-only row was private to. The replay says "hiders only" (everyone sees it there). */
export const PrivateWordContext = createContext<string | null>(null)
