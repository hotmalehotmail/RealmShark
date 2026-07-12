import { Sprite } from '../sprites/Sprite'
import { Swatch } from './Swatch'

/** The 4 equipped slots: weapon / ability / armor / ring. */
const SLOT_COUNT = 4

interface GearRowProps {
  /** Equipped-item objectTypes by slot; a missing array or slot renders a placeholder swatch. */
  equipment: number[] | null | undefined
  /** Slot icon edge length in px; <= 0 renders nothing (a panel size hiding its gear row). */
  slotSize: number
}

/** A player's 4 equipment-slot icons in a row, placeholder swatches for empty slots. */
export function GearRow({ equipment, slotSize }: GearRowProps): React.JSX.Element | null {
  if (slotSize <= 0) return null
  const slots = Array.from({ length: SLOT_COUNT }, (_, i) => equipment?.[i] ?? -1)
  return (
    <div className={`flex shrink-0 items-center ${slotSize >= 16 ? 'gap-1' : 'gap-0.5'}`}>
      {slots.map((itemType, i) =>
        itemType > 0 ? (
          <Sprite key={i} objectType={itemType} size={slotSize} />
        ) : (
          <Swatch key={i} size={slotSize} />
        )
      )}
    </div>
  )
}
