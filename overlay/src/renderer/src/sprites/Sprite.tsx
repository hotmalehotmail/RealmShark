import { useEffect, useId, useState } from 'react'
import { AnimatedDyeCanvas } from './AnimatedDyeCanvas'
import { useSprites } from './context'
import { RARITY_RING_CLASS } from './enchantRarity'

interface SpriteProps {
  /** The RotMG objectType to render. Null/undefined renders nothing. */
  objectType: number | null | undefined
  /** Rendered pixel size (square). */
  size?: number
  /** Clothing dye objectType (Tex1) to composite onto a character sprite. */
  clothingDye?: number | null
  /** Accessory dye objectType (Tex2) to composite onto a character sprite. */
  accessoryDye?: number | null
  /**
   * Enchant rarity-border tier (0=common/no border..4=divine) - see
   * sprites/enchantRarity.ts. Renders as a coloured ring around the sprite so
   * it never changes the sprite's own layout size.
   */
  rarity?: number | null
  /**
   * Whether to render the shiny-item badge (a small rainbow star in the
   * top-left corner) - see sprites/shiny.ts. Like `rarity`, this overlays
   * without changing the sprite's own layout size.
   */
  shiny?: boolean
  className?: string
}

/** A small rainbow-gradient star, absolutely positioned over the sprite's top-left corner. */
function ShinyBadge({ size }: { size: number }): React.JSX.Element {
  const gradientId = useId()
  const badgeSize = Math.max(7, Math.round(size * 0.42))
  return (
    <svg
      viewBox="0 0 24 24"
      width={badgeSize}
      height={badgeSize}
      className="pointer-events-none absolute -left-1 -top-1"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#ff5757" />
          <stop offset="25%" stopColor="#ffbd47" />
          <stop offset="50%" stopColor="#5cff7e" />
          <stop offset="75%" stopColor="#57a8ff" />
          <stop offset="100%" stopColor="#c157ff" />
        </linearGradient>
      </defs>
      <path
        d="M12 1.6 14.7 8.6 22.2 9.3 16.5 14.3 18.2 21.6 12 17.7 5.8 21.6 7.5 14.3 1.8 9.3 9.3 8.6Z"
        fill={`url(#${gradientId})`}
        stroke="rgba(0,0,0,0.45)"
        strokeWidth="1"
      />
    </svg>
  )
}

/** Deterministic placeholder colour so an unresolved objectType is still a stable chip. */
function placeholderColor(objectType: number): string {
  const hue = (objectType * 47) % 360
  return `hsl(${hue} 45% 40%)`
}

/** Ring utility classes for a rarity tier, or '' for tier 0/unset (no border). */
function rarityRingClassName(rarity: number | null | undefined): string {
  return rarity ? (RARITY_RING_CLASS[rarity] ?? '') : ''
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
  rarity,
  shiny,
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
  const rarityClass = rarityRingClassName(rarity)
  const combinedClassName = [className, rarityClass].filter(Boolean).join(' ') || undefined

  let rendered: React.JSX.Element | null = null

  if (dyed && smooth) {
    const bake = bakeAnimatedDye(objectType, size, clothingDye, accessoryDye)
    if (bake) {
      rendered = (
        <AnimatedDyeCanvas
          bake={bake}
          size={size}
          scrollSpeed={scrollSpeed}
          rotateSpeed={rotateSpeed}
          className={combinedClassName}
        />
      )
    }
  }

  if (!rendered) {
    const url = dyed
      ? getDyedSprite(objectType, size, clothingDye, accessoryDye)
      : getSprite(objectType, size)
    rendered = url ? (
      <img
        src={url}
        width={size}
        height={size}
        className={combinedClassName}
        style={{ imageRendering: 'pixelated' }}
        alt=""
      />
    ) : (
      <span
        className={combinedClassName}
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

  if (!shiny) return rendered

  return (
    <span className="relative inline-block" style={{ width: size, height: size, flexShrink: 0 }}>
      {rendered}
      <ShinyBadge size={size} />
    </span>
  )
}
