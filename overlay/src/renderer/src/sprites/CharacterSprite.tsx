import { useEffect } from 'react'
import { useEntityRegistry, useSprites } from './context'
import { Sprite } from './Sprite'

interface CharacterSpriteProps {
  /** objectId of the character to render; skin + dyes are resolved from the registry. */
  objectId: number | null | undefined
  size?: number
  className?: string
}

// TEMP dye diagnostic: dedup the skin-vs-class mask log per base objectType.
const loggedChar = new Set<number>()

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
  const sprites = useSprites()
  const skin = reg.skin(objectId)
  const classType = reg.objectType(objectId)
  const base = skin != null && skin > 0 ? skin : classType

  // TEMP dye diagnostic: is the missing mask a skin-vs-class issue?
  useEffect(() => {
    if (base == null || loggedChar.has(base)) return
    loggedChar.add(base)
    console.log(
      `[dye-char] obj=${objectId} skin=${skin ?? 0}(mask=${skin ? sprites.hasMask(skin) : '-'}) ` +
        `class=${classType ?? 0}(mask=${classType ? sprites.hasMask(classType) : '-'}) base=${base}`
    )
  }, [base, objectId, skin, classType, sprites])

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
