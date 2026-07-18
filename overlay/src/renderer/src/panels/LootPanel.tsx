import type { PanelSize } from '../../../shared/panels'
import type { LootEntry } from '../loot/LootTracker'
import { TRACKED_BAG_TYPES } from '../loot/LootTracker'
import { useLootTracker } from '../loot/useLootTracker'
import { ItemSprite } from '../sprites/ItemSprite'
import { Sprite } from '../sprites/Sprite'
import { Swatch } from '../ui/Swatch'
import type { PanelContentProps } from './registry'

/** Bag-color header sprite pixel size per panel size. */
const BAG_ICON_SIZE: Record<PanelSize, number> = { sm: 18, md: 22, lg: 28 }
/** Dropped-item sprite pixel size per panel size. */
const ITEM_SIZE: Record<PanelSize, number> = { sm: 18, md: 24, lg: 30 }

/**
 * Session log of white/orange bag drops (BagType 6/8) that appeared near the
 * local player, grouped under each color's own bag sprite as the category
 * header. Backed by `useLootTracker()`, a session-scoped, framework-agnostic
 * tracker that reads the loot-bag entities themselves (see `LootTracker`'s
 * docstring and `docs/overlay-renderer.md` §5.1 for the DPS-summary pattern it
 * mirrors) - so an item is logged when it *drops*, not when it's picked up.
 * Both tracked bag categories always render (even at 0 drops) so the panel's
 * layout is stable across a session; the header is just the bag sprite + a
 * count, no "White Bag"/"Orange Bag" text - the sprite is recognizable on its
 * own. The scroll container carries a small inset (`p-1.5`) so an edge
 * item's rarity indicator (bottom-right) and shiny indicator (top-left)
 * (both outset overlays - see sprites/enchantRarity.ts and sprites/shiny.ts)
 * aren't clipped by the edge.
 * <p>
 * Enchantments: each dropped item's enchants come straight from the bag
 * entity's own `UNIQUE_DATA_STRING` (one encoded code per slot, captured by
 * `LootTracker` into `LootEntry.enchantCode`), rendered via `ItemSprite`'s
 * `enchantCode` path - the rarity border + the tooltip's enchant list, exactly
 * as the game shows when you hover a bag. No dependence on the item being
 * equipped, unlike the old inventory-pickup tracker.
 */
function LootPanel({ size }: PanelContentProps): React.JSX.Element {
  const { entriesByBagType, bagIcon, itemName, isShiny } = useLootTracker()

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto p-1.5">
      {TRACKED_BAG_TYPES.map((bagType) => {
        const entries = entriesByBagType[bagType]
        const icon = bagIcon(bagType)
        // Newest drop first, so the most recent drop is visible without scrolling.
        const ordered: LootEntry[] = [...entries].reverse()
        return (
          <div key={bagType} className="flex flex-col gap-1">
            <div className="flex items-center gap-1.5">
              {icon != null ? (
                <Sprite objectType={icon} size={BAG_ICON_SIZE[size]} />
              ) : (
                <Swatch size={BAG_ICON_SIZE[size]} />
              )}
              <span className="text-xs text-fg-faint">{entries.length}</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {ordered.map((entry) => {
                const resolvedName = itemName(entry.objectType)
                const name = resolvedName ?? `#${entry.objectType}`
                return (
                  <div key={entry.id} className="flex items-center gap-1">
                    <ItemSprite
                      objectType={entry.objectType}
                      size={ITEM_SIZE[size]}
                      rarity={entry.rarity}
                      enchantCode={entry.enchantCode}
                      shiny={isShiny(entry.objectType)}
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
