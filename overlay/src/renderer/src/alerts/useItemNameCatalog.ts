import { useEffect, useRef, useState } from 'react'
import type { LootBagTypesData } from '../loot/types'

/**
 * Every distinct item display name from the bridge's `lootBagTypes` envelope
 * (issue #217 widened `itemNames` to cover all bag colors, ~11.4k items),
 * sorted, for the `enchantedDrop` params editor's item-name-override
 * autocomplete (`paramsEditors.ts`). A standalone subscription rather than
 * reusing `AlertEngine`'s private `LootTracker` instance - this is a UI-only
 * concern (an `<input list>` autocomplete), not part of the alerts core's
 * layering contract (`docs/notifications.md` "The layering contract"), so it
 * mirrors `ItemInfoProvider`'s own direct `onPacketBatch` subscription rather
 * than reaching into engine internals.
 */
export function useItemNameCatalog(): readonly string[] {
  const [names, setNames] = useState<readonly string[]>([])
  const namesReceivedCount = useRef(0)
  const lastMetaVersion = useRef<string | undefined>(undefined)

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => {
      for (const env of packets) {
        if (env.type === 'lootBagTypes') {
          const data = env.data as LootBagTypesData | null
          const version = data?.metaVersion
          // Version short-circuit first (issue #239): a same-version
          // re-delivery (WS reconnect) skips even the Object.values scan of
          // the ~12.4k-entry table. A changed version applies regardless of
          // the count below (a re-extraction can change names without
          // changing how many there are); the count guard remains only as the
          // change signal for version-less (pre-#239 capture) envelopes.
          if (version != null && version === lastMetaVersion.current) continue
          const values = Object.values(data?.itemNames ?? {})
          if (values.length === 0) continue
          if (version == null && values.length === namesReceivedCount.current) continue
          namesReceivedCount.current = values.length
          lastMetaVersion.current = version
          setNames([...new Set(values)].sort((a, b) => a.localeCompare(b)))
        }
      }
    })
    // This hook mounts with the settings view - long after the bridge's
    // one-shot, edge-triggered `lootBagTypes` delivery (#239) - so without
    // asking main to re-send its cached copy the catalog stays empty forever
    // (issue #245: "the item filter dropdown no longer appears"). Requested
    // after subscribing above so the replayed batch can't race the listener.
    void window.overlay.replayMetadata()
    return offBatch
  }, [])

  return names
}
