import type { ReactNode } from 'react'

interface MeterRowProps {
  /** Proportional background-fill width, 0-100 (clamped). 0 renders no visible fill. */
  fillPct: number
  /** Accent the row as the local player: tinted fill + inset accent ring. */
  highlight?: boolean
  /** Fixed row height in px, for lists whose total height must not vary with row count. */
  height?: number
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
 * the content for horizontal space and can't overflow the row.
 */
export function MeterRow({
  fillPct,
  highlight,
  height,
  className,
  onClick,
  children
}: MeterRowProps): React.JSX.Element {
  const pct = Math.max(0, Math.min(100, fillPct))
  const frame = `relative flex w-full items-center gap-1.5 overflow-hidden rounded-sm text-xs ${
    highlight ? 'ring-1 ring-inset ring-accent/70' : ''
  } ${className ?? ''}`
  const frameStyle = height != null ? { height } : undefined
  const body = (
    <>
      <div
        className={`absolute inset-y-0 left-0 ${highlight ? 'bg-accent/25' : 'bg-surface-2'}`}
        style={{ width: `${pct}%` }}
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
