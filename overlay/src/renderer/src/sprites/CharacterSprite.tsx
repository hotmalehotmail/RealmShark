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
}: CharacterSpriteProps): React.JSX.Element | null {
  const reg = useEntityRegistry()
  const skin = reg.skin(objectId)
  const base = skin != null && skin > 0 ? skin : reg.objectType(objectId)
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
