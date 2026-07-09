import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { useEntityRegistry } from '../sprites/context'
import { Sprite } from '../sprites/Sprite'
import type { PanelContentProps } from './registry'

/** Big-sprite pixel size per panel size. */
const PLAYER_SIZE: Record<PanelSize, number> = { sm: 40, md: 64, lg: 88 }
/** Equipment-slot icon pixel size per panel size. */
const SLOT_SIZE: Record<PanelSize, number> = { sm: 20, md: 28, lg: 36 }

/** Re-read cadence, matching useDpsTracker - the registry is ref-backed and doesn't re-render on packets. */
const REFRESH_MS = 500

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

  useEffect(() => {
    const interval = setInterval(() => setTick((n) => n + 1), REFRESH_MS)
    return () => clearInterval(interval)
  }, [])

  const localId = entities.localPlayerId()
  if (localId == null) {
    return <div className="text-xs text-white/40">Waiting for local player…</div>
  }

  const skinType = entities.skin(localId)
  const classType = entities.objectType(localId)
  const spriteType = skinType && skinType > 0 ? skinType : classType
  const equipment = entities.equipment(localId) ?? []
  const name = entities.name(localId)

  return (
    <div className="flex h-full w-full flex-col text-white">
      <div className="flex items-center gap-3">
        <Sprite objectType={spriteType} size={PLAYER_SIZE[size]} />
        <div className="min-w-0">
          <div className="truncate text-sm font-semibold">{name ?? `Player #${localId}`}</div>
          {size !== 'sm' && <div className="text-xs text-white/40">You</div>}
        </div>
      </div>

      <div className="mt-3 flex items-center gap-1.5">
        {equipment.map((itemType, i) =>
          itemType > 0 ? (
            <Sprite key={i} objectType={itemType} size={SLOT_SIZE[size]} />
          ) : (
            <span
              key={i}
              className="rounded-sm border border-white/15 bg-white/5"
              style={{ width: SLOT_SIZE[size], height: SLOT_SIZE[size], flexShrink: 0 }}
            />
          )
        )}
      </div>
    </div>
  )
}

export default CharacterPanel
