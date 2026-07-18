import { createContext, useContext } from 'react'
import type { FiredAlertStore } from './store'

/**
 * Exposes the App-level `AlertEngine`'s `FiredAlertStore` to any panel that
 * wants to view it (issue #220's `NotificationsPanel`) without reaching into
 * `AlertEngine` internals - the same store `AlertToastHost` already consumes
 * directly as a prop (PRD §1 layering contract: every UI surface reads only
 * the store's subscribe API). A context rather than a prop because
 * `NotificationsPanel` is mounted by `PANEL_REGISTRY` lookup deep under
 * `PanelCanvas`, with no direct parent/child relationship to `App` - same
 * rationale as `dps/dpsDetailContext.ts`. Kept in its own file (context +
 * hook only, no component) for the same `react-refresh/only-export-
 * components` reason `dpsDetailContext.ts` is split from its provider.
 */
export const AlertStoreContext = createContext<FiredAlertStore | null>(null)

export function useAlertStore(): FiredAlertStore {
  const ctx = useContext(AlertStoreContext)
  if (!ctx) {
    throw new Error('useAlertStore must be used within an AlertStoreContext.Provider')
  }
  return ctx
}
