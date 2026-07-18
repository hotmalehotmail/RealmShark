import { useEffect, useState } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { useAlertStore } from '../alerts/alertStoreContext'
import type { FiredAlert } from '../alerts/types'
import { ItemSprite } from '../sprites/ItemSprite'
import { EmptyState } from '../ui/EmptyState'
import type { PanelContentProps } from './registry'

/** Payload-icon sprite pixel size per panel size. */
const ICON_SIZE: Record<PanelSize, number> = { sm: 20, md: 24, lg: 28 }

function formatTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}

/**
 * A pure viewer over the App-level `AlertEngine`'s `FiredAlertStore` (issue
 * #220 - PRD §4 "History"): a missed banner/ping is transient, this panel is
 * the durable record. Reads the store via `useAlertStore()` (React context,
 * `alertStoreContext.ts`) rather than a prop, and imports nothing from
 * `AlertEngine`/`catalog`/`dispatcher` or any packet type - only the store's
 * subscribe API and `FiredAlert` (PRD §1 layering contract, binding
 * acceptance criteria for every notification-system UI surface). Deleting
 * this panel from the layout doesn't stop alerts firing; it just stops
 * showing their history.
 * <p>
 * Newest-first, mirroring `LootPanel`'s "most recent drop visible without
 * scrolling" convention. Each row shows the fired time, the payload's
 * `icon` (via `ItemSprite`, when set - not every alert has one), title/body,
 * and the full list of matched catalog kind ids (PRD §3 point 4: a banner
 * only shows one payload even when multiple rules matched, so the history
 * row is where "why did this fire" is fully visible) - hidden at `sm` where
 * there's no room to show it usefully.
 */
function NotificationsPanel({ size }: PanelContentProps): React.JSX.Element {
  const store = useAlertStore()
  const [alerts, setAlerts] = useState<readonly FiredAlert[]>(() => [...store.getAll()])

  useEffect(() => store.subscribe((next) => setAlerts([...next])), [store])

  if (alerts.length === 0) {
    return (
      <div className="flex h-full w-full items-center justify-center p-2">
        <EmptyState>no notifications yet</EmptyState>
      </div>
    )
  }

  const ordered = [...alerts].reverse()

  return (
    <div className="flex h-full w-full flex-col gap-1.5 overflow-y-auto p-1.5">
      {ordered.map((alert) => (
        <div
          key={alert.id}
          className="flex items-start gap-2 rounded border border-edge/60 bg-surface-2 px-2 py-1.5"
        >
          {alert.payload.icon != null && (
            <ItemSprite objectType={alert.payload.icon} size={ICON_SIZE[size]} />
          )}
          <div className="flex min-w-0 flex-1 flex-col">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-xs font-medium text-fg">{alert.payload.title}</span>
              <span className="shrink-0 text-2xs text-fg-faint">{formatTime(alert.time)}</span>
            </div>
            <span className="truncate text-2xs text-fg-muted">{alert.payload.body}</span>
            {size !== 'sm' && (
              <span className="truncate text-2xs text-fg-faint">
                {alert.matchedKindIds.join(', ')}
              </span>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

export default NotificationsPanel
