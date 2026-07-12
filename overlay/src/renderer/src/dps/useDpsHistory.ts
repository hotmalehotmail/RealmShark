import { useEffect, useState } from 'react'
import { DpsTracker, type DpsHistoryEntry } from './DpsTracker'

/**
 * Owns a dedicated `DpsTracker` instance whose only job is retention: it
 * ingests the same packet stream as the live DPS panel's tracker (see
 * useDpsTracker.ts) but is never asked for a live single-target snapshot,
 * only its retained instance history. Kept as its own tracker instance
 * (rather than sharing the live panel's) so the DPS summary panel works
 * standalone and never perturbs the live glance panel's state.
 *
 * Because PanelFrame keeps every panel in the layout mounted for the app's
 * whole session (only toggling `display:none`, never unmounting - see
 * App.tsx), and the summary panel is in the default layout, this tracker
 * keeps recording instance history even while the panel itself isn't
 * visible, matching the "session-scoped, in-memory" retention this feature
 * needs.
 */
export function useDpsHistory(): DpsHistoryEntry[] {
  const [tracker] = useState(() => new DpsTracker())
  const [history, setHistory] = useState<DpsHistoryEntry[]>([])

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => {
      tracker.ingest(packets)
      // History only changes when an instance ends - avoid re-rendering (and
      // reallocating the array) on every damage packet.
      if (packets.some((p) => p.type === 'MapInfoPacket')) {
        setHistory([...tracker.getHistory()])
      }
    })
    // The game closing ends whatever instance was in progress the same way a
    // MapInfoPacket would, but there's no next MapInfoPacket to trigger the
    // retention hook - just reset live state; retaining a fight cut short by
    // closing the game is a nice-to-have, not required by this feature.
    const offDetach = window.overlay.onOverlayDetach(() => tracker.reset())
    return () => {
      offBatch()
      offDetach()
    }
  }, [tracker])

  return history
}
