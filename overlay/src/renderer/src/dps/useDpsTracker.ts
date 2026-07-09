import { useEffect, useState } from 'react'
import { DPS_DEBUG, DpsTracker, EMPTY_SNAPSHOT, type DpsSnapshot } from './DpsTracker'

const RECOMPUTE_INTERVAL_MS = 200
/** Emit the [dps] state summary once every this many recomputes (~5s), to keep the log readable. */
const DEBUG_SUMMARY_EVERY = 25

export function useDpsTracker(): DpsSnapshot {
  const [tracker] = useState(() => new DpsTracker())
  const [snapshot, setSnapshot] = useState<DpsSnapshot>(EMPTY_SNAPSHOT)

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => tracker.ingest(packets))
    const offDetach = window.overlay.onOverlayDetach(() => {
      tracker.reset()
      setSnapshot(EMPTY_SNAPSHOT)
    })
    let ticks = 0
    const interval = setInterval(() => {
      setSnapshot(tracker.snapshot(Date.now()))
      if (DPS_DEBUG && ++ticks % DEBUG_SUMMARY_EVERY === 0) {
        console.log('[dps]', tracker.debugSummary())
      }
    }, RECOMPUTE_INTERVAL_MS)
    return () => {
      offBatch()
      offDetach()
      clearInterval(interval)
    }
  }, [tracker])

  return snapshot
}
