import { useEffect, useState } from 'react'
import { type DpsHistoryEntry } from './DpsTracker'
import { useDpsFeed } from './dpsFeedContext'

/**
 * Retained past-instance history, as a view over the app's shared
 * `DpsTracker` (`useDpsFeed` - PRD §3; this hook no longer owns a private
 * "retention-only" tracker instance). Because the `DpsFeedProvider` ingests
 * at App level for the app's whole session, history keeps recording even
 * while no DPS panel is in the layout - hence the mount-time backfill below,
 * which the old always-mounted private tracker never needed.
 */
export function useDpsHistory(): DpsHistoryEntry[] {
  const feed = useDpsFeed()
  // Lazy initializer backfills whatever the shared tracker retained before
  // this view mounted (feed is app-lifetime stable, so mount time is the only
  // moment a backfill is needed).
  const [history, setHistory] = useState<DpsHistoryEntry[]>(() => [...feed.tracker.getHistory()])

  useEffect(() => {
    // History only changes when an instance ends - avoid re-rendering (and
    // reallocating the array) on every damage packet. The game closing ends
    // whatever instance was in progress too, but with no next MapInfoPacket
    // there's nothing new to retain - the provider's detach reset covers the
    // live-state wipe, and history itself survives reset() by design.
    return feed.onBatch((packets) => {
      if (packets.some((p) => p.type === 'MapInfoPacket')) {
        setHistory([...feed.tracker.getHistory()])
      }
    })
  }, [feed])

  return history
}
