import { useSprites } from './context'

interface SpriteProps {
  /** The RotMG objectType to render. Null/undefined renders nothing. */
  objectType: number | null | undefined
  /** Rendered pixel size (square). */
  size?: number
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
  className
}: SpriteProps): React.JSX.Element | null {
  const { getSprite } = useSprites()
  if (objectType == null) return null

  const url = getSprite(objectType, size)
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
