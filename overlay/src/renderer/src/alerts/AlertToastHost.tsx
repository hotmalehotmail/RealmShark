import { useEffect, useRef, useState } from 'react'
import { ItemSprite } from '../sprites/ItemSprite'
import { pingPlayer } from './sound'
import type { FiredAlertStore } from './store'
import { ToastQueue, type ToastQueueState } from './toastQueue'
import type { FiredAlert } from './types'

export interface AlertToastHostProps {
  store: FiredAlertStore
  /** Overlay's interactive/hidden mode - drives `pointer-events-none` and hides the click-to-dismiss affordance while hidden (PRD §4, mirrors the pinned-panel rationale: banners must still fire mid-gameplay). */
  interactive: boolean
  /** `NotificationsSettings.volume` (0..1) - forwarded to `pingPlayer` unchanged; muting is `pingPlayer`'s own concern. */
  volume: number
}

/**
 * Top-center transient banner stack over `PanelCanvas` (PRD §4, issue #219).
 * Watches `store` (the `FiredAlertStore` an `AlertEngine` owns) for alerts it
 * hasn't seen yet: each one whose `banner` flag is set is pushed into a
 * `ToastQueue` (cap 3 + FIFO overflow, auto-dismiss ~5s - see that file);
 * each one whose `sound` flag is set plays the bundled ping through
 * `pingPlayer` (coalesced there). This is the ONE place both channels are
 * triggered from a fired alert - the layering contract (PRD §1) still holds
 * because `store`/`types` stay React-free; only this consuming component
 * touches the DOM/audio.
 * <p>
 * Rendered unconditionally in `AppShell` (like `PanelCanvas`) so it survives
 * toggling interactive mode - visibility instead follows `interactive` via
 * `pointer-events-none` (hidden mode: banners still show, but can't be
 * clicked away - the overlay isn't capturing input then anyway) vs. normal
 * pointer events + click-to-dismiss (interactive mode).
 */
export function AlertToastHost({
  store,
  interactive,
  volume
}: AlertToastHostProps): React.JSX.Element {
  const [queue] = useState(() => new ToastQueue())
  const [state, setState] = useState<ToastQueueState>(() => queue.getState())
  const seenIds = useRef<Set<string>>(new Set())

  // Seed with whatever's already in the store at mount (e.g. a remount while
  // the engine's session log persists) so history isn't replayed as fresh
  // toasts - only alerts appended AFTER this component is watching become
  // toasts/pings.
  useEffect(() => {
    for (const alert of store.getAll()) seenIds.current.add(alert.id)
  }, [store])

  useEffect(() => queue.subscribe(setState), [queue])
  useEffect(() => () => queue.dispose(), [queue])

  useEffect(() => {
    return store.subscribe((alerts) => {
      for (const alert of alerts) {
        if (seenIds.current.has(alert.id)) continue
        seenIds.current.add(alert.id)
        if (alert.banner) queue.push(alert)
        if (alert.sound) pingPlayer.play(volume)
      }
    })
  }, [store, queue, volume])

  const handleDismiss = (alert: FiredAlert): void => {
    if (interactive) queue.dismiss(alert.id)
  }

  if (state.visible.length === 0) return <></>

  return (
    <div
      className={`absolute top-2 left-1/2 z-50 flex -translate-x-1/2 flex-col items-stretch gap-1.5 ${
        interactive ? '' : 'pointer-events-none'
      }`}
    >
      {state.visible.map((alert) => (
        <div
          key={alert.id}
          onClick={() => handleDismiss(alert)}
          className={`flex w-72 items-center gap-2 rounded-lg border border-edge bg-panel px-2.5 py-2 shadow-lg backdrop-blur-sm ${
            interactive ? 'cursor-pointer' : ''
          }`}
        >
          {alert.payload.icon != null && <ItemSprite objectType={alert.payload.icon} size={28} />}
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-sm font-medium text-fg">{alert.payload.title}</span>
            <span className="truncate text-2xs text-fg-muted">{alert.payload.body}</span>
          </div>
        </div>
      ))}
      {state.overflow > 0 && (
        <div className="flex justify-center">
          <div className="rounded-full border border-edge bg-panel px-2.5 py-0.5 text-2xs text-fg-faint shadow-lg backdrop-blur-sm">
            +{state.overflow} more
          </div>
        </div>
      )}
    </div>
  )
}
