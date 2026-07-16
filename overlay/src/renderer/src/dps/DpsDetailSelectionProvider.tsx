import { useCallback, useState } from 'react'
import { DpsDetailSelectionContext } from './dpsDetailContext'
import type { DpsHistoryEntry } from './DpsTracker'

/** Owns the selection state for `dpsDetailContext.ts` - see its doc comment. */
export function DpsDetailSelectionProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const [selected, setSelected] = useState<DpsHistoryEntry | null>(null)
  const select = useCallback((entry: DpsHistoryEntry) => setSelected(entry), [])
  const clear = useCallback(() => setSelected(null), [])

  return (
    <DpsDetailSelectionContext.Provider value={{ selected, select, clear }}>
      {children}
    </DpsDetailSelectionContext.Provider>
  )
}
