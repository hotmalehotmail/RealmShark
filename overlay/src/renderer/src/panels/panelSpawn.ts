import { createContext, useContext } from 'react'
import type { PanelSize } from '../../../shared/panels'

/**
 * Lets a panel's own content component programmatically open/close *another*
 * panel on the canvas - e.g. `DpsSummaryPanel` opening a big detail view of a
 * selected session (issue #194) rather than swapping its own small content in
 * place. Provided once by `PanelCanvas` (which owns the `PanelInstance[]`
 * state this manipulates), consumed via `usePanelSpawn()` by any panel body
 * that needs it. See `docs/overlay-renderer.md`'s "Programmatic panel
 * spawn/close" section.
 */
export interface PanelSpawnApi {
  /**
   * Ensures a panel instance with this `id`/`type` exists on the canvas and
   * is raised to the front - creates it (at a default anchor, the given
   * `size`) if it doesn't exist yet, otherwise just brings the existing one
   * to top. Reuses the same instance across repeated calls with the same
   * `id`, so re-targeting an already-open panel (e.g. selecting a different
   * session) never spawns a duplicate.
   */
  openPanel: (id: string, type: string, size?: PanelSize) => void
  /** Removes a panel instance from the canvas entirely. */
  closePanel: (id: string) => void
  /**
   * Whether a panel instance with this `id` currently exists on the canvas -
   * lets a spawning panel body (e.g. `DpsSummaryPanel`) derive UI state (like
   * a row highlight) from the spawned panel's actual open/closed state
   * instead of tracking it separately in a way that must be manually kept in
   * sync when the panel closes.
   */
  isOpen: (id: string) => boolean
}

export const PanelSpawnContext = createContext<PanelSpawnApi | null>(null)

/**
 * Throws outside a `PanelSpawnContext.Provider` (i.e. outside `PanelCanvas`
 * or a harness mount that provides a stand-in) rather than silently no-oping
 * - a panel body calling this without a provider is a wiring bug, not a
 * valid state.
 */
export function usePanelSpawn(): PanelSpawnApi {
  const ctx = useContext(PanelSpawnContext)
  if (!ctx) throw new Error('usePanelSpawn must be used within a PanelSpawnContext.Provider')
  return ctx
}
