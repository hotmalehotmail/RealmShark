import { useEffect, useState } from 'react'
import type { LootBagTypesData } from '../loot/types'

/**
 * Every distinct item display name from the bridge's `lootBagTypes` envelope
 * (issue #217 widened `itemNames` to cover all bag colors, ~11.4k items),
 * sorted, for the `enchantedDrop` params editor's item-name-override
 * autocomplete (`paramsEditors.tsx`). A standalone subscription rather than
 * reusing `AlertEngine`'s private `LootTracker` instance - this is a UI-only
 * concern (an `<input list>` autocomplete), not part of the alerts core's
 * layering contract (`docs/notifications.md` "The layering contract"), so it
 * mirrors `ItemInfoProvider`'s own direct `onPacketBatch` subscription rather
 * than reaching into engine internals.
 */
export function useItemNameCatalog(): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([])

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => {
      for (const env of packets) {
        if (env.type === 'lootBagTypes') {
          const data = env.data as LootBagTypesData | null
          const values = Object.values(data?.itemNames ?? {})
          if (values.length > 0) {
            setNames([...new Set(values)].sort((a, b) => a.localeCompare(b)))
          }
        }
      }
    })
    return offBatch
  }, [])

  return names
}
