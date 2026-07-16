import { createContext, useContext } from 'react'
import type { DpsHistoryEntry } from './DpsTracker'

/**
 * Cross-panel selection state for the DPS summary/detail panel split (issue
 * #194): which past instance's frozen `DpsHistoryEntry` the (separate,
 * larger) detail panel should render. `DpsSummaryPanel`'s master list writes
 * this on row click; `DpsDetailPanel` reads it. A React context rather than a
 * prop, since the two panels are independent siblings under `PanelCanvas`,
 * each mounted by `PANEL_REGISTRY` lookup with no direct parent/child
 * relationship - see `docs/overlay-renderer.md`'s "Programmatic panel
 * spawn/close" section. Kept in this plain `.ts` file (context + hook only,
 * no component) rather than alongside `DpsDetailSelectionProvider` - a
 * provider file that also exports a hook fails the `react-refresh/only-
 * export-components` lint rule, the same reason `sprites/context.ts` is
 * split from `EntityRegistry.tsx`.
 */
export interface DpsDetailSelectionApi {
  selected: DpsHistoryEntry | null
  select: (entry: DpsHistoryEntry) => void
  /** Clears the selection - called by `DpsDetailPanel` when it unmounts (closes), so the summary list's row highlight doesn't outlive the detail panel it implies is open. */
  clear: () => void
}

export const DpsDetailSelectionContext = createContext<DpsDetailSelectionApi | null>(null)

export function useDpsDetailSelection(): DpsDetailSelectionApi {
  const ctx = useContext(DpsDetailSelectionContext)
  if (!ctx) {
    throw new Error('useDpsDetailSelection must be used within a DpsDetailSelectionProvider')
  }
  return ctx
}
