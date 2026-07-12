import { decodeEnchantIds } from '../items/enchantDecode'
import { useItemInfo } from '../items/context'
import { Tooltip } from '../ui/Tooltip'
import { useEntityRegistry } from './context'
import { Sprite } from './Sprite'

interface ItemSpriteProps {
  objectType: number
  size?: number
  className?: string
  /** Enchant rarity-border tier (0-4), forwarded to `<Sprite>` — see sprites/enchantRarity.ts. */
  rarity?: number | null
  /**
   * The equipping entity's objectId, paired with `slotIndex` to resolve that
   * player's enchant data for this slot (`EntityRegistry.enchantSlots`) when
   * `enchantCode` isn't given directly. Omit for an item with no owning
   * entity (e.g. a ground-loot icon in the Loot panel with no equipped-slot
   * match) - the tooltip then shows item info only, no enchant section.
   */
  ownerObjectId?: number
  /** Equipped slot index (0=weapon, 1=ability, 2=armor, 3=ring), paired with `ownerObjectId`. */
  slotIndex?: number
  /**
   * A pre-resolved raw `UNIQUE_DATA_STRING` slot code, taking priority over
   * the `ownerObjectId`/`slotIndex` live-lookup path - for a caller holding
   * its own frozen enchant data (e.g. `DpsSummaryPanel`'s retained history,
   * whose `ownerObjectId` may no longer resolve in the live `EntityRegistry`
   * after an instance change). An empty string means "known, no
   * enchantments"; omit entirely to fall back to the live lookup.
   */
  enchantCode?: string
}

/**
 * The shared item-rendering path (issue #109): wraps `<Sprite>` with a hover
 * tooltip showing the item's info (name/tier/class/damage/description, from
 * the bridge's `itemInfo` envelope) and, for an equipped slot whose owner is
 * known, its enchantments (decoded client-side from `EntityRegistry`'s raw
 * `enchantSlots`, named via the `enchantNames` envelope where available).
 * `GearRow` and the Loot panel both render items through this component, so
 * every current and future item-rendering panel gets tooltips for free - see
 * `docs/overlay-renderer.md` §4.
 */
export function ItemSprite({
  objectType,
  size = 32,
  className,
  rarity,
  ownerObjectId,
  slotIndex,
  enchantCode
}: ItemSpriteProps): React.JSX.Element {
  const { itemName, itemTier, itemClass, itemDescription, itemDamage, enchantName } = useItemInfo()
  const entities = useEntityRegistry()

  const name = itemName(objectType) ?? `#${objectType}`
  const tier = itemTier(objectType)
  const clazz = itemClass(objectType)
  const description = itemDescription(objectType)
  const damage = itemDamage(objectType)

  const liveSlots = ownerObjectId != null ? entities.enchantSlots(ownerObjectId) : null
  const liveSlot = liveSlots != null && slotIndex != null ? (liveSlots[slotIndex] ?? null) : null
  const rawSlot = enchantCode !== undefined ? enchantCode : liveSlot
  const enchantIds = rawSlot != null ? decodeEnchantIds(rawSlot) : null

  const content = (
    <div className="flex flex-col gap-0.5">
      <div className="font-semibold text-fg">{name}</div>
      {(tier || clazz) && (
        <div className="text-2xs text-fg-faint">
          {[tier && `Tier ${tier}`, clazz].filter(Boolean).join(' · ')}
        </div>
      )}
      {damage && (
        <div className="text-2xs text-fg-muted">
          Damage {damage[0]}-{damage[1]}
        </div>
      )}
      {description && <div className="text-2xs text-fg-muted">{description}</div>}
      {rawSlot != null && (
        <div className="mt-1 flex flex-col gap-0.5 border-t border-edge pt-1">
          {enchantIds && enchantIds.length > 0 ? (
            enchantIds.map((id, i) => (
              <span key={i} className="text-2xs text-accent/80">
                {enchantName(id) ?? `Enchant #${id}`}
              </span>
            ))
          ) : (
            <span className="text-2xs text-fg-faint">No enchantments</span>
          )}
        </div>
      )}
    </div>
  )

  return (
    <Tooltip content={content} className={className}>
      <Sprite objectType={objectType} size={size} rarity={rarity} />
    </Tooltip>
  )
}
