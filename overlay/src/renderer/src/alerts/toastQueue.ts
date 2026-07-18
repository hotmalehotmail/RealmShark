import type { FiredAlert } from './types'

/** How long a visible toast stays up before auto-dismissing (PRD §4). */
const TOAST_MS = 5000

/** Simultaneous visible toasts (PRD §4 "Stack capped at 3"). */
const MAX_VISIBLE = 3

export interface ToastQueueState {
  /** Currently visible toasts, oldest first. */
  visible: readonly FiredAlert[]
  /** Alerts waiting for a visible slot to free up - the "+N more" count. */
  overflow: number
}

/**
 * Framework-agnostic queue backing `AlertToastHost` (issue #219, PRD §4):
 * decides which fired alerts are currently shown as banners, independent of
 * React so the cap/overflow/auto-dismiss timing is unit-testable without
 * rendering anything (`docs/overlay-testing.md` - this suite runs under
 * vitest's plain `node` environment, no jsdom/RTL).
 *
 * Capped at {@link MAX_VISIBLE} simultaneous toasts; a `push` beyond the cap
 * waits in a FIFO queue rather than being dropped, and is promoted into a
 * freed slot the moment an older toast auto-dismisses or is clicked away -
 * so a burst (e.g. an 8-item bag) eventually shows every banner-worthy
 * alert instead of silently losing the overflow ones. Self-schedules its
 * own auto-dismiss via `setTimeout` (real wall-clock time, not tied to
 * packet/game time - these are purely transient session UI), so tests drive
 * it with `vi.useFakeTimers()` the same way `overlay/test/replay.ts` does
 * for the trackers.
 */
export class ToastQueue {
  private visibleAlerts: FiredAlert[] = []
  private pending: FiredAlert[] = []
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly listeners = new Set<(state: ToastQueueState) => void>()

  /** Enqueues one banner-worthy fired alert; shows it immediately if a slot is free, else queues it. */
  push(alert: FiredAlert): void {
    this.pending.push(alert)
    this.pump()
  }

  /** Click-to-dismiss (interactive mode only) - removes the toast now and promotes the next queued one, if any. */
  dismiss(alertId: string): void {
    if (!this.visibleAlerts.some((a) => a.id === alertId)) return
    this.clearTimer(alertId)
    this.visibleAlerts = this.visibleAlerts.filter((a) => a.id !== alertId)
    this.pump()
  }

  getState(): ToastQueueState {
    return { visible: this.visibleAlerts, overflow: this.pending.length }
  }

  /** Subscribes to every state change (push/dismiss/expire). Returns an unsubscribe function. */
  subscribe(listener: (state: ToastQueueState) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Full teardown - cancels every pending auto-dismiss timer AND clears
   * visible/queued state, so a disposed instance is genuinely empty rather
   * than leaving stale entries a remount (a real unmount/remount, or React
   * StrictMode's dev-only double-invoke of effects) would otherwise inherit
   * with no timers left to ever clear them. Call on unmount.
   */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.visibleAlerts = []
    this.pending = []
  }

  private pump(): void {
    while (this.visibleAlerts.length < MAX_VISIBLE && this.pending.length > 0) {
      const alert = this.pending.shift()!
      this.visibleAlerts.push(alert)
      this.timers.set(
        alert.id,
        setTimeout(() => this.expire(alert.id), TOAST_MS)
      )
    }
    this.notify()
  }

  private expire(alertId: string): void {
    this.timers.delete(alertId)
    this.visibleAlerts = this.visibleAlerts.filter((a) => a.id !== alertId)
    this.pump()
  }

  private clearTimer(alertId: string): void {
    const timer = this.timers.get(alertId)
    if (timer !== undefined) {
      clearTimeout(timer)
      this.timers.delete(alertId)
    }
  }

  private notify(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}
