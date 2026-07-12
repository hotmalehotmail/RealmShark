import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import type { LootEntry, TrackedBagType } from '../loot/LootTracker'
import { TRACKED_BAG_TYPES } from '../loot/LootTracker'
import { useLootTracker } from '../loot/useLootTracker'
import { useEntityRegistry } from '../sprites/context'
import { ItemSprite } from '../sprites/ItemSprite'
import { Sprite } from '../sprites/Sprite'
import { EmptyState } from '../ui/EmptyState'
import { Swatch } from '../ui/Swatch'
import type { PanelContentProps } from './registry'

/** Bag-color header sprite pixel size per panel size. */
const BAG_ICON_SIZE: Record<PanelSize, number> = { sm: 18, md: 22, lg: 28 }
/** Obtained-item sprite pixel size per panel size. */
const ITEM_SIZE: Record<PanelSize, number> = { sm: 18, md: 24, lg: 30 }

/** Fixed category labels - the two tracked BagTypes never change (see docs/asset-pipeline.md). */
const BAG_LABELS: Record<TrackedBagType, string> = { 6: 'White Bag', 8: 'Orange Bag' }

/**
 * Session log of the local player's white/orange bag drops (BagType 6/8),
 * grouped under each color's own bag sprite as the category header. Backed
 * by `useLootTracker()`, a session-scoped, framework-agnostic tracker
 * (persists across instance changes, cleared only on overlay detach/game
 * close - see `LootTracker`'s docstring and `docs/overlay-renderer.md` §5.1
 * for the equivalent DPS-summary pattern this mirrors). A category with no
 * drops yet is hidden entirely; the whole panel shows the shared `EmptyState`
 * only when nothing has dropped at all this session.
 * <p>
 * Enchantments (issue #122): the game never broadcasts a bag-slot item's
 * enchant data over the wire - `UNIQUE_DATA_STRING` only ever describes the 4
 * currently-EQUIPPED slots (see `EntityRegistry`'s docstring) - so a picked-up
 * item's enchants are showable only in the one case where they're actually
 * known: the item is presently equipped by the local player. Each entry is
 * matched by objectType against the local player's live `equipment`; a match
 * gets the full enchant-aware tooltip (via `ItemSprite`'s `ownerObjectId`/
 * `slotIndex`, the same path `GearRow` uses), everything else falls back to
 * item-info-only, same as before.
 */
function LootPanel({ size }: PanelContentProps): React.JSX.Element {
  const { entriesByBagType, bagIcon, itemName } = useLootTracker()
  const entities = useEntityRegistry()
  const [, setTick] = useState(0)

  // Re-render when the local player's equipment changes, so an item just
  // equipped picks up its enchant tooltip without waiting for the next loot
  // event (useLootTracker only re-renders on loot-tracker-relevant changes).
  useEffect(() => entities.subscribe(() => setTick((n) => n + 1)), [entities])

  const localPlayerId = entities.localPlayerId()
  const localEquipment = localPlayerId != null ? entities.equipment(localPlayerId) : null

  const totalCount = TRACKED_BAG_TYPES.reduce(
    (n, bagType) => n + entriesByBagType[bagType].length,
    0
  )
  if (totalCount === 0) {
    return <EmptyState>No white/orange bag drops yet this session</EmptyState>
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto">
      {TRACKED_BAG_TYPES.map((bagType) => {
        const entries = entriesByBagType[bagType]
        if (entries.length === 0) return null
        const icon = bagIcon(bagType)
        // Newest pickup first, so the most recent drop is visible without scrolling.
        const ordered: LootEntry[] = [...entries].reverse()
        return (
          <div key={bagType} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              {icon != null ? (
                <Sprite objectType={icon} size={BAG_ICON_SIZE[size]} />
              ) : (
                <Swatch size={BAG_ICON_SIZE[size]} />
              )}
              <span className="text-xs text-fg-faint">
                {BAG_LABELS[bagType]} · {entries.length}
              </span>
            </div>
            <div className="flex flex-wrap gap-1">
              {ordered.map((entry) => {
                const name = itemName(entry.objectType) ?? `#${entry.objectType}`
                const equippedSlot = localEquipment?.indexOf(entry.objectType) ?? -1
                return (
                  <div key={entry.id} className="flex items-center gap-1">
                    <ItemSprite
                      objectType={entry.objectType}
                      size={ITEM_SIZE[size]}
                      ownerObjectId={equippedSlot >= 0 ? (localPlayerId ?? undefined) : undefined}
                      slotIndex={equippedSlot >= 0 ? equippedSlot : undefined}
                    />
                    {size === 'lg' && <span className="max-w-[90px] truncate text-xs">{name}</span>}
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default LootPanel
