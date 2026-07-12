import type { ButtonHTMLAttributes } from 'react'

type ButtonVariant = 'subtle' | 'ghost' | 'primary' | 'success' | 'warn'
type ButtonSize = 'xs' | 'sm' | 'md'

// The one place filled-button shades live; raw palette classes are allowed
// only inside ui/ (see docs/overlay-ui-style.md).
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  subtle: 'bg-surface-2 hover:bg-surface-3',
  ghost: 'text-fg-faint hover:text-fg-muted',
  primary: 'bg-sky-600 font-medium hover:bg-sky-500',
  success: 'bg-emerald-600 font-medium hover:bg-emerald-500',
  warn: 'bg-amber-600 font-medium hover:bg-amber-500'
}

const SIZE_STYLES: Record<ButtonSize, string> = {
  xs: 'px-1 text-2xs',
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-3 py-1.5 text-sm'
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Ghost only: color the button as an engaged toggle (e.g. a pinned panel's pin). */
  active?: boolean
}

/** Every button in the overlay: variant picks the colors, size the padding/type. */
export function Button({
  variant = 'subtle',
  size = 'sm',
  active,
  className,
  ...rest
}: ButtonProps): React.JSX.Element {
  const colors =
    active && variant === 'ghost' ? 'text-success hover:text-success/80' : VARIANT_STYLES[variant]
  return (
    <button
      type="button"
      className={`rounded disabled:opacity-50 ${colors} ${SIZE_STYLES[size]} ${className ?? ''}`}
      {...rest}
    />
  )
}
