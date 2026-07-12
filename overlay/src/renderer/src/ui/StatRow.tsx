import type { ReactNode } from 'react'

interface StatRowProps {
  label: string
  /** Layout-only additions (margins, dividers) — colors stay in the primitive. */
  className?: string
  children: ReactNode
}

/** Label-left / numeric-value-right line, e.g. "Packets seen    1234". */
export function StatRow({ label, className, children }: StatRowProps): React.JSX.Element {
  return (
    <div className={`flex items-baseline justify-between ${className ?? ''}`}>
      <span className="text-fg-muted">{label}</span>
      <span className="font-mono text-base tabular-nums">{children}</span>
    </div>
  )
}
