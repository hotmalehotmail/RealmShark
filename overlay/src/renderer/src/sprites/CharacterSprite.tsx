import { useEntityRegistry } from './context'
import { Sprite } from './Sprite'

interface CharacterSpriteProps {
  /** objectId of the character to render; skin + dyes are resolved from the registry. */
  objectId: number | null | undefined
  size?: number
  className?: string
}

/**
 * Renders a character's sprite for an objectId, dyed - the skin (or class)
 * sprite with its clothing/accessory dyes composited in, all resolved from the
 * shared EntityRegistry. Usable from any panel: `<CharacterSprite objectId={id} />`.
 */
export function CharacterSprite({
  objectId,
  size = 32,
  className
}: CharacterSpriteProps): React.JSX.Element {
  const reg = useEntityRegistry()
  const skin = reg.skin(objectId)
  const classType = reg.objectType(objectId)
  const base = skin != null && skin > 0 ? skin : classType

  // No objectType known for this id yet (e.g. a DPS row for a player the
  // registry hasn't seen an UpdatePacket for). Same bordered-box placeholder
  // as an unresolved equipment slot, rather than rendering nothing.
  if (base == null) {
    return (
      <span
        className={`rounded-sm border border-white/15 bg-white/5 ${className ?? ''}`}
        style={{ width: size, height: size, flexShrink: 0 }}
      />
    )
  }

  return (
    <Sprite
      objectType={base}
      size={size}
      clothingDye={reg.clothingDye(objectId)}
      accessoryDye={reg.accessoryDye(objectId)}
      className={className}
    />
  )
}
