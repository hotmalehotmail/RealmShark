import { useEffect, useState } from 'react'
import { LootTracker, TRACKED_BAG_TYPES, type LootEntry, type TrackedBagType } from './LootTracker'

export interface LootSnapshot {
  entriesByBagType: Record<TrackedBagType, LootEntry[]>
  bagIcon: (bagType: TrackedBagType) => number | null
  itemName: (objectType: number) => string | null
}

const EMPTY_ENTRIES: LootEntry[] = []

/**
 * React wrapper around a dedicated `LootTracker` instance (independent from
 * any other panel's, same pattern as `useDpsHistory`), event-driven off
 * `onPacketBatch`: `LootTracker.ingest` reports whether anything
 * display-relevant changed, so this only re-renders on an actual loot/meta
 * update instead of every packet batch.
 */
export function useLootTracker(): LootSnapshot {
  const [tracker] = useState(() => new LootTracker())
  const [, setTick] = useState(0)

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => {
      if (tracker.ingest(packets)) setTick((n) => n + 1)
    })
    const offDetach = window.overlay.onOverlayDetach(() => {
      tracker.reset()
      setTick((n) => n + 1)
    })
    return () => {
      offBatch()
      offDetach()
    }
  }, [tracker])

  const entriesByBagType = {} as Record<TrackedBagType, LootEntry[]>
  for (const bagType of TRACKED_BAG_TYPES) {
    const entries = tracker.entriesFor(bagType)
    entriesByBagType[bagType] = entries.length > 0 ? entries : EMPTY_ENTRIES
  }

  return {
    entriesByBagType,
    bagIcon: (bagType) => tracker.bagIcon(bagType),
    itemName: (objectType) => tracker.itemName(objectType)
  }
}
