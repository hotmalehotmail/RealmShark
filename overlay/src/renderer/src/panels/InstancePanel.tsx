import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { CharacterSprite } from '../sprites/CharacterSprite'
import { useEntityRegistry } from '../sprites/context'
import { EmptyState } from '../ui/EmptyState'
import { GearRow } from '../ui/GearRow'
import type { PanelContentProps } from './registry'

/** Character-sprite pixel size per panel size. */
const CHAR_SIZE: Record<PanelSize, number> = { sm: 40, md: 52, lg: 64 }
/** Equipment-slot icon pixel size per panel size. */
const SLOT_SIZE: Record<PanelSize, number> = { sm: 16, md: 20, lg: 24 }

/**
 * Lists every character (player) in the current instance - their dyed sprite,
 * username, and equipped items - resolved through the shared EntityRegistry.
 * Players carry NAME_STAT (monsters don't), so the registry's `characters()`
 * gives the instance roster. The local player is listed first. Primarily a
 * surface for eyeballing many dyed/textiled characters at once.
 */
function InstancePanel({ size }: PanelContentProps): React.JSX.Element {
  const entities = useEntityRegistry()
  const [, setTick] = useState(0)

  // Re-render only when the registry reports a relevant change (event-driven),
  // instead of polling on a timer.
  useEffect(() => entities.subscribe(() => setTick((n) => n + 1)), [entities])

  const localId = entities.localPlayerId()
  const ids = entities.characters().sort((a, b) => {
    if (a === localId) return -1
    if (b === localId) return 1
    return a - b
  })

  if (ids.length === 0) {
    return <EmptyState>No characters in the instance yet…</EmptyState>
  }

  return (
    <div className="flex h-full w-full flex-col gap-2 overflow-y-auto pr-1">
      {ids.map((id) => {
        const name = entities.name(id)
        return (
          <div key={id} className="flex items-center gap-2">
            <CharacterSprite objectId={id} size={CHAR_SIZE[size]} />
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex items-baseline gap-1.5">
                <span className="truncate font-semibold">{name ?? `#${id}`}</span>
                {id === localId && <span className="text-2xs text-accent/70">you</span>}
              </div>
              <GearRow
                equipment={entities.equipment(id)}
                rarity={entities.equipmentRarity(id)}
                slotSize={SLOT_SIZE[size]}
                ownerObjectId={id}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

export default InstancePanel
