import { createContext, useContext } from 'react'
import type { DpsFeed } from './dpsFeed'

/**
 * Context handle for the app's single shared `DpsFeed` (see dpsFeed.ts).
 * Kept in a plain `.ts` file (context + hook only, no component) separate
 * from `DpsFeedProvider` for the same `react-refresh/only-export-components`
 * reason as `dpsDetailContext.ts`.
 */
export const DpsFeedContext = createContext<DpsFeed | null>(null)

export function useDpsFeed(): DpsFeed {
  const ctx = useContext(DpsFeedContext)
  if (!ctx) {
    throw new Error('useDpsFeed must be used within a DpsFeedProvider')
  }
  return ctx
}
