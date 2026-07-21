import { useEffect, useState } from 'react'
import { BIN_MS, type DpsGraphSeries } from './DpsRateRecorder'
import { useDpsFeed } from './dpsFeedContext'

/**
 * The sparkline's data feed: mirrors `useDpsTracker`'s event-driven pattern
 * (issue #259 - an earlier interval-only version left a real, if narrow,
 * staleness window right after mount/an instance reset, since the recorder
 * can finish ingesting a whole burst of `dps` envelopes well inside one
 * BIN_MS tick, and nothing forced an immediate re-read). Re-reads the
 * recorder's aggregate series the moment a `dps` envelope arrives, with the
 * BIN_MS interval kept as the decay driver: bins close on **time**, not
 * envelopes (PRD §2), so the line still needs a tick even when the packet
 * stream goes quiet. While the series is flat at zero the previous state
 * object is kept either way, so an idle overlay re-renders nothing and
 * steady-state GPU work stays at zero over the game.
 */
export function useDpsGraph(): DpsGraphSeries {
  const feed = useDpsFeed()
  const [series, setSeries] = useState<DpsGraphSeries>(() =>
    feed.tracker.recorder.graphSeries(Date.now())
  )

  useEffect(() => {
    const read = (): void => {
      const next = feed.tracker.recorder.graphSeries(Date.now())
      setSeries((prev) => (prev.windowMax === 0 && next.windowMax === 0 ? prev : next))
    }
    const offBatch = feed.onBatch((packets) => {
      if (packets.some((p) => p.type === 'dps')) read()
    })
    const interval = setInterval(read, BIN_MS)
    return () => {
      offBatch()
      clearInterval(interval)
    }
  }, [feed])

  return series
}
