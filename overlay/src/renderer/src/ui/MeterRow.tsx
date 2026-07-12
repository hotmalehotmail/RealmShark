import type { ReactNode } from 'react'

const TEXT_SIZE_CLASS = { '2xs': 'text-2xs', xs: 'text-xs', sm: 'text-sm' } as const

interface MeterRowProps {
  /** Proportional fill width AND color, 0-100 (clamped): both encode the same
   *  share (typically damage / topDamage). 0 renders no visible fill. */
  fillPct: number
  /** Accent the row as the local player: inset accent ring only — the fill's
   *  color is driven solely by `fillPct`, independent of `highlight`, so the
   *  local player stays identifiable by the ring (and a caller-rendered rank
   *  badge) without it fighting the share-color scale. */
  highlight?: boolean
  /** Fixed row height in px, for lists whose total height must not vary with row count. */
  height?: number
  /** Row text size. Secondary figures (badges, dps) commonly opt into '2xs'
   *  individually regardless of this. Defaults to 'xs' (prior fixed size). */
  textSize?: '2xs' | 'xs' | 'sm'
  /** Layout-only additions (padding etc.) — colors stay in the primitive. */
  className?: string
  /** When set, the row renders as a <button>. */
  onClick?: () => void
  children: ReactNode
}

/**
 * A list row with a proportional damage-bar fill painted behind its content.
 * The fill is an absolutely-positioned div under a relative z-10 content
 * wrapper, clipped by the row (overflow-hidden), so it never competes with
 * the content for horizontal space and can't overflow the row. The fill's
 * color is `color-mix`'d between the `--color-meter-low`/`--color-meter-high`
 * tokens by `fillPct`, so a row's bar communicates its share by both length
 * and color (see `overlay-ui-style.md`).
 */
export function MeterRow({
  fillPct,
  highlight,
  height,
  textSize = 'xs',
  className,
  onClick,
  children
}: MeterRowProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, fillPct))
  const frame = `relative flex w-full items-center gap-1.5 overflow-hidden rounded-sm ${
    TEXT_SIZE_CLASS[textSize]
  } ${highlight ? 'ring-1 ring-inset ring-accent/70' : ''} ${className ?? ''}`
  const frameStyle = height != null ? { height } : undefined
  const body = (
    <>
      <div
        className="absolute inset-y-0 left-0"
        style={{
          width: `${pct}%`,
          backgroundColor: `color-mix(in oklab, var(--color-meter-high) ${pct}%, var(--color-meter-low))`
        }}
      />
      <div className="relative z-10 flex w-full min-w-0 items-center gap-1.5">{children}</div>
    </>
  )
  if (onClick) {
    return (
      <button type="button" className={`${frame} text-left`} style={frameStyle} onClick={onClick}>
        {body}
      </button>
    )
  }
  return (
    <div className={frame} style={frameStyle}>
      {body}
    </div>
  )
}
