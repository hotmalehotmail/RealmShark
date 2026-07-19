import { useEffect, useState } from 'react'
import { DPS_DEBUG, EMPTY_SNAPSHOT, type DpsSnapshot } from './DpsTracker'
import { useDpsFeed } from './dpsFeedContext'

/**
 * Slow fallback recompute. The bridge pushes a `dps` snapshot on every damage
 * event (coalesced) plus a heartbeat, so the panel is event-driven; this timer
 * only exists so the client-side rolling-window fallback (used when the bridge
 * has no data for the focused enemy) still decays when packets go quiet.
 */
const FALLBACK_INTERVAL_MS = 1000

/**
 * Live single-target DPS snapshot, as a view over the app's shared
 * `DpsTracker` (`useDpsFeed` - PRD §3; this hook no longer owns a private
 * tracker instance). Ingestion/reset are the `DpsFeedProvider`'s job; this
 * hook only decides *when* to re-read `snapshot()`.
 */
export function useDpsTracker(): DpsSnapshot {
  const feed = useDpsFeed()
  const [snapshot, setSnapshot] = useState<DpsSnapshot>(EMPTY_SNAPSHOT)

  useEffect(() => {
    const offBatch = feed.onBatch((packets) => {
      // Re-snapshot when a fresh bridge `dps` snapshot arrives. The bridge pushes
      // one within ~50ms of any damage packet (and a focus switch rides along,
      // since that hit marks the bridge dirty), so this captures every relevant
      // change while staying capped at the bridge's coalesced rate. Also
      // re-snapshot immediately on QuestObjectIdPacket so a boss lock/phase
      // transition shows up right away instead of waiting for the 1s fallback.
      if (packets.some((p) => p.type === 'dps' || p.type === 'QuestObjectIdPacket')) {
        setSnapshot(feed.tracker.snapshot(Date.now()))
      }
    })
    const offDetach = feed.onDetach(() => setSnapshot(EMPTY_SNAPSHOT))
    const interval = setInterval(() => {
      setSnapshot(feed.tracker.snapshot(Date.now()))
      if (DPS_DEBUG) console.log('[dps]', feed.tracker.debugSummary())
    }, FALLBACK_INTERVAL_MS)
    return () => {
      offBatch()
      offDetach()
      clearInterval(interval)
    }
  }, [feed])

  return snapshot
}
