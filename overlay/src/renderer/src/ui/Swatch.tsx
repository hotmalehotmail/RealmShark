interface SwatchProps {
  /** Square edge length in px. */
  size: number
  className?: string
}

/**
 * Bordered empty box: the stable placeholder for an unknown sprite or an
 * empty equipment slot, so unresolved content never renders as a blank gap.
 */
export function Swatch({ size, className }: SwatchProps): React.JSX.Element {
  return (
    <span
      className={`inline-block shrink-0 rounded-sm border border-edge bg-surface ${className ?? ''}`}
      style={{ width: size, height: size }}
    />
  )
}
