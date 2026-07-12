import type { PanelSize } from '../../../shared/panels'
import type { LootEntry, TrackedBagType } from '../loot/LootTracker'
import { TRACKED_BAG_TYPES } from '../loot/LootTracker'
import { useLootTracker } from '../loot/useLootTracker'
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
 */
function LootPanel({ size }: PanelContentProps): React.JSX.Element {
  const { entriesByBagType, bagIcon, itemName } = useLootTracker()

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
                return (
                  <div key={entry.id} className="flex items-center gap-1">
                    <ItemSprite objectType={entry.objectType} size={ITEM_SIZE[size]} />
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
