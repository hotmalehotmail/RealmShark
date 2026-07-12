import { useEffect, useState } from 'react'
import { AnimatedDyeCanvas } from './AnimatedDyeCanvas'
import { useSprites } from './context'

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
  const {
    getSprite,
    getDyedSprite,
    isAnimated,
    dyeAnimated,
    bakeAnimatedDye,
    frameMs,
    scrollSpeed,
    rotateSpeed
  } = useSprites()

  // If this sprite animates, tick locally so it advances; static sprites never
  // tick. This drives discrete frame-cycling (idle character frames, a
  // multi-frame textile) at the configured frame rate - including for a
  // dyeAnimated sprite whose base also happens to have idle frames. The
  // continuous scroll/rotate motion itself doesn't depend on this tick at
  // all: AnimatedDyeCanvas below subscribes to the shared rAF clock instead,
  // so multiple animated sprites stay vsync-aligned and in phase with each
  // other regardless of this (much coarser) frame-select re-render.
  const [, setTick] = useState(0)
  const animated = isAnimated(objectType, clothingDye, accessoryDye)
  const smooth = dyeAnimated(clothingDye, accessoryDye)
  useEffect(() => {
    if (!animated) return
    const id = setInterval(() => setTick((t) => t + 1), Math.max(50, frameMs))
    return () => clearInterval(id)
  }, [animated, frameMs])

  if (objectType == null) return null

  const dyed =
    (clothingDye != null && clothingDye > 0) || (accessoryDye != null && accessoryDye > 0)

  if (dyed && smooth) {
    const bake = bakeAnimatedDye(objectType, size, clothingDye, accessoryDye)
    if (bake) {
      return (
        <AnimatedDyeCanvas
          bake={bake}
          size={size}
          scrollSpeed={scrollSpeed}
          rotateSpeed={rotateSpeed}
          className={className}
        />
      )
    }
  }

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
