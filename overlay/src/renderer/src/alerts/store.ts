import type { AlertPayload, FiredAlert } from './types'

/** Cap on the session log (PRD §4 "History") - oldest dropped first. */
const MAX_HISTORY = 200

/**
 * Bounded session log of fired alerts. Persists across `MapInfoPacket`
 * (instance changes) exactly like `LootTracker.entries` - `AlertEngine`
 * never clears it on a map change, only on `reset()` (overlay detach / game
 * close). Every future UI surface (the toast host, the history panel - PRD
 * §1 "Layering contract") consumes only this store's `subscribe`/`getAll`
 * API, never the engine's internals, so a UI redesign never needs to change
 * this class.
 */
export class FiredAlertStore {
  private alerts: FiredAlert[] = []
  private nextId = 1
  private listeners = new Set<(alerts: readonly FiredAlert[]) => void>()

  /** Appends one fired alert, evicting the oldest entry past `MAX_HISTORY`, and notifies subscribers. */
  append(payload: AlertPayload, matchedKindIds: string[], time: number): FiredAlert {
    const alert: FiredAlert = { id: String(this.nextId++), time, payload, matchedKindIds }
    this.alerts.push(alert)
    if (this.alerts.length > MAX_HISTORY) this.alerts.shift()
    this.notify()
    return alert
  }

  /** Chronological (oldest-first) snapshot of the current session log. */
  getAll(): readonly FiredAlert[] {
    return this.alerts
  }

  /** Subscribes to every future change (append or reset). Returns an unsubscribe function. */
  subscribe(listener: (alerts: readonly FiredAlert[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Full reset (overlay detach / game close) - clears the session log itself, mirroring `LootTracker.reset()`. */
  reset(): void {
    this.alerts = []
    this.notify()
  }

  private notify(): void {
    for (const listener of this.listeners) listener(this.alerts)
  }
}
