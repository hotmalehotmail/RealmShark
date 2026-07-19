import { useEffect, useState } from 'react'
import { BIN_MS, type DpsGraphSeries } from './DpsRateRecorder'
import { useDpsFeed } from './dpsFeedContext'

/**
 * The sparkline's data feed: reads the shared recorder's aggregate series on
 * a fixed BIN_MS tick (PRD §4 - discrete updates at bin cadence, ~4 Hz, never
 * per-envelope). While the series is flat at zero the previous state object
 * is kept, so an idle overlay re-renders nothing and steady-state GPU work
 * stays at zero over the game.
 */
export function useDpsGraph(): DpsGraphSeries {
  const feed = useDpsFeed()
  const [series, setSeries] = useState<DpsGraphSeries>(() =>
    feed.tracker.recorder.graphSeries(Date.now())
  )

  useEffect(() => {
    const interval = setInterval(() => {
      const next = feed.tracker.recorder.graphSeries(Date.now())
      setSeries((prev) => (prev.windowMax === 0 && next.windowMax === 0 ? prev : next))
    }, BIN_MS)
    return () => clearInterval(interval)
  }, [feed])

  return series
}
