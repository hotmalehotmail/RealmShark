import { useEffect, useState } from 'react'
import { DpsTracker, EMPTY_SNAPSHOT, type DpsSnapshot } from './DpsTracker'

const RECOMPUTE_INTERVAL_MS = 500

export function useDpsTracker(): DpsSnapshot {
  const [tracker] = useState(() => new DpsTracker())
  const [snapshot, setSnapshot] = useState<DpsSnapshot>(EMPTY_SNAPSHOT)

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => tracker.ingest(packets))
    const offDetach = window.overlay.onOverlayDetach(() => {
      tracker.reset()
      setSnapshot(EMPTY_SNAPSHOT)
    })
    const interval = setInterval(() => {
      setSnapshot(tracker.snapshot(Date.now()))
    }, RECOMPUTE_INTERVAL_MS)
    return () => {
      offBatch()
      offDetach()
      clearInterval(interval)
    }
  }, [tracker])

  return snapshot
}
