import type { ReactNode } from 'react'

/** The muted placeholder line shown when a panel has nothing to display yet. */
export function EmptyState({ children }: { children: ReactNode }): React.JSX.Element {
  return <div className="text-xs text-fg-faint">{children}</div>
}
