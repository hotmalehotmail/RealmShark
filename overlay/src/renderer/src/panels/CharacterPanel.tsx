import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { CharacterSprite } from '../sprites/CharacterSprite'
import { useEntityRegistry } from '../sprites/context'
import { EmptyState } from '../ui/EmptyState'
import { GearRow } from '../ui/GearRow'
import type { PanelContentProps } from './registry'

/** Big-sprite pixel size per panel size. */
const PLAYER_SIZE: Record<PanelSize, number> = { sm: 40, md: 64, lg: 88 }
/** Equipment-slot icon pixel size per panel size. */
const SLOT_SIZE: Record<PanelSize, number> = { sm: 20, md: 28, lg: 36 }

/**
 * Shows the local player: a large sprite (equipped skin if set, else the class
 * objectType), a row of the 4 equipped-slot icons (weapon/ability/armor/ring),
 * and the username. All resolved through the shared EntityRegistry + <Sprite>
 * path, so it renders real atlas sprites when game assets are loaded and stable
 * placeholder chips otherwise. Party members are a future extension.
 */
function CharacterPanel({ size }: PanelContentProps): React.JSX.Element {
  const entities = useEntityRegistry()
  const [, setTick] = useState(0)

  // Re-render only when the registry reports a relevant change (event-driven).
  useEffect(() => entities.subscribe(() => setTick((n) => n + 1)), [entities])

  const localId = entities.localPlayerId()
  if (localId == null) {
    return <EmptyState>Waiting for local player…</EmptyState>
  }

  const name = entities.name(localId)

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-3">
        <CharacterSprite objectId={localId} size={PLAYER_SIZE[size]} />
        <div className="min-w-0">
          <div className="truncate font-semibold">{name ?? `Player #${localId}`}</div>
          {size !== 'sm' && <div className="text-xs text-fg-faint">You</div>}
        </div>
      </div>

      <div className="mt-3">
        <GearRow equipment={entities.equipment(localId)} slotSize={SLOT_SIZE[size]} />
      </div>
    </div>
  )
}

export default CharacterPanel
