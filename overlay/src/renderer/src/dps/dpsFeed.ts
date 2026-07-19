import type { PacketEnvelope } from '../../../shared/ipc'
import { DpsTracker } from './DpsTracker'

/**
 * The single shared `DpsTracker` and its ingest fan-out (PRD §3,
 * docs/prd-dps-graph.md). Exactly one instance exists per app session, owned
 * by `DpsFeedProvider` at App level, replacing the old two-instance pattern
 * (one tracker per hook). Consumers (`useDpsTracker`, `useDpsHistory`,
 * `useDpsGraph`) subscribe here instead of `window.overlay.onPacketBatch`
 * directly: React flushes effects bottom-up (children before parents), so a
 * child hook subscribing to the preload bridge itself would run *before* the
 * provider's ingest and read one batch stale. `onBatch` callbacks are always
 * invoked after the shared tracker has ingested the batch.
 *
 * Plain TS (no React) so the whole ingest-then-notify contract is testable
 * headless via the capture-replay harness (`feed.ingest` satisfies
 * `Ingestable`).
 */
export class DpsFeed {
  readonly tracker = new DpsTracker()
  private batchListeners = new Set<(packets: PacketEnvelope[]) => void>()
  private detachListeners = new Set<() => void>()

  /** Ingest one batch into the shared tracker, then notify subscribers. */
  ingest(packets: PacketEnvelope[]): void {
    this.tracker.ingest(packets)
    for (const cb of this.batchListeners) cb(packets)
  }

  /** The game closed (overlay `detach`): reset the shared tracker (history survives - see `DpsTracker.reset`), then notify. */
  detach(): void {
    this.tracker.reset()
    for (const cb of this.detachListeners) cb()
  }

  /** `cb` runs after every ingested batch, with the batch that was ingested. */
  onBatch(cb: (packets: PacketEnvelope[]) => void): () => void {
    this.batchListeners.add(cb)
    return () => this.batchListeners.delete(cb)
  }

  /** `cb` runs after every detach-triggered reset. */
  onDetach(cb: () => void): () => void {
    this.detachListeners.add(cb)
    return () => this.detachListeners.delete(cb)
  }
}
