import { useEffect, useState } from 'react'
import { useSprites } from './context'
import { DYE_ANIM_MS } from './SpriteProvider'

interface SpriteProps {
  /** The RotMG objectType to render. Null/undefined renders nothing. */
  objectType: number | null | undefined
  /** Rendered pixel size (square). */
  size?: number
  /** Clothing dye objectType (Tex1) to composite onto a character sprite. */
  clothingDye?: number | null
  /** Accessory dye objectType (Tex2) to composite onto a character sprite. */
  accessoryDye?: number | null
  className?: string
}

/** Deterministic placeholder colour so an unresolved objectType is still a stable chip. */
function placeholderColor(objectType: number): string {
  const hue = (objectType * 47) % 360
  return `hsl(${hue} 45% 40%)`
}

/**
 * Renders the sprite for an objectType, shared across all panels. When the real
 * sprite pack is available it draws the cropped atlas sprite; otherwise (no game
 * assets on the bridge) it falls back to a stable coloured placeholder chip so
 * the UI is still meaningful.
 */
export function Sprite({
  objectType,
  size = 32,
  clothingDye,
  accessoryDye,
  className
}: SpriteProps): React.JSX.Element | null {
  const { getSprite, getDyedSprite, isAnimated, dyeAnimated, frameMs } = useSprites()

  // If this sprite animates (idle character frames or an animated textile dye),
  // tick locally so it advances; static sprites never tick. A continuously
  // scrolling/rotating cloth ticks at the smooth DYE_ANIM_MS; frame-cycling
  // sprites tick at the (coarser) configured frame rate.
  const [, setTick] = useState(0)
  const animated = isAnimated(objectType, clothingDye, accessoryDye)
  const smooth = dyeAnimated(clothingDye, accessoryDye)
  useEffect(() => {
    if (!animated) return
    const interval = smooth ? DYE_ANIM_MS : Math.max(50, frameMs)
    const id = setInterval(() => setTick((t) => t + 1), interval)
    return () => clearInterval(id)
  }, [animated, smooth, frameMs])

  if (objectType == null) return null

  const dyed =
    (clothingDye != null && clothingDye > 0) || (accessoryDye != null && accessoryDye > 0)
  const url = dyed
    ? getDyedSprite(objectType, size, clothingDye, accessoryDye)
    : getSprite(objectType, size)
  if (url) {
    return (
      <img
        src={url}
        width={size}
        height={size}
        className={className}
        style={{ imageRendering: 'pixelated' }}
        alt=""
      />
    )
  }

  return (
    <span
      className={className}
      style={{
        width: size,
        height: size,
        background: placeholderColor(objectType),
        borderRadius: 2,
        display: 'inline-block',
        flexShrink: 0
      }}
    />
  )
}
