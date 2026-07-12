import { ItemSprite } from '../sprites/ItemSprite'
import { Swatch } from './Swatch'

/** The 4 equipped slots: weapon / ability / armor / ring. */
const SLOT_COUNT = 4

interface GearRowProps {
  /** Equipped-item objectTypes by slot; a missing array or slot renders a placeholder swatch. */
  equipment: number[] | null | undefined
  /**
   * Enchant rarity-border tier (0-4) by slot, parallel to `equipment` - see
   * sprites/enchantRarity.ts. A missing array or slot renders no border.
   */
  rarity?: number[] | null
  /** Slot icon edge length in px; <= 0 renders nothing (a panel size hiding its gear row). */
  slotSize: number
  /**
   * The equipping entity's objectId, so a hovered slot's tooltip can resolve
   * that player's enchant data (`EntityRegistry.enchantSlots`) when
   * `enchantSlots` below isn't given. Omit when unknown - the tooltip then
   * shows item info only, no enchant section.
   */
  ownerObjectId?: number
  /**
   * Frozen raw per-slot `UNIQUE_DATA_STRING` codes, parallel to `equipment` -
   * takes priority over the `ownerObjectId` live lookup. Pass this for a
   * historical/frozen row (e.g. `DpsSummaryPanel`'s past-instance detail)
   * whose `ownerObjectId` may no longer resolve in the live `EntityRegistry`;
   * omit to use the live lookup (e.g. a currently-tracked roster row).
   */
  enchantSlots?: (string | null | undefined)[] | null
}

/** A player's 4 equipment-slot icons in a row, placeholder swatches for empty slots. */
export function GearRow({
  equipment,
  rarity,
  slotSize,
  ownerObjectId,
  enchantSlots
}: GearRowProps): React.JSX.Element | null {
  if (slotSize <= 0) return null
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => equipment?.[i] ?? -1)
  return (
    <div className={`flex shrink-0 items-center ${slotSize >= 16 ? 'gap-1' : 'gap-0.5'}`}>
      {slots.map((itemType, i) =>
        itemType > 0 ? (
          <ItemSprite
            key={i}
            objectType={itemType}
            size={slotSize}
            rarity={rarity?.[i]}
            ownerObjectId={ownerObjectId}
            slotIndex={i}
            enchantCode={enchantSlots ? (enchantSlots[i] ?? '') : undefined}
          />
        ) : (
          <Swatch key={i} size={slotSize} />
        )
      )}
    </div>
  )
}
