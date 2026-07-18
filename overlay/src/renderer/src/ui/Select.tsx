import type { SelectHTMLAttributes } from 'react'

/**
 * Every `<select>` in the overlay (the dropdown counterpart to `Button`).
 * `className` is layout-only (width, `flex-1`, …) per the `ui/` primitive
 * convention — colors/sizing are this component's own business. See
 * `main.css`'s `select option` rule for why the option list itself needs a
 * separate, explicit style (soak #232).
 */
export function Select({
  className,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>): React.JSX.Element {
  return (
    <select
      className={`rounded border border-edge bg-surface-2 px-1 py-0.5 text-2xs text-fg ${className ?? ''}`}
      {...rest}
    />
  )
}
