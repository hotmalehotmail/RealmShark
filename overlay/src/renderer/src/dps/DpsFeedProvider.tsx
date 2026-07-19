import { useEffect, useState } from 'react'
import { DpsFeed } from './dpsFeed'
import { DpsFeedContext } from './dpsFeedContext'

/**
 * Owns the app's single shared `DpsFeed`/`DpsTracker` (PRD §3) and wires it
 * to the preload bridge. Mounted once at App level (and in the harness's
 * `PanelMount`), above every panel, so ingestion - and therefore instance-
 * history retention - runs for the app's whole session regardless of which
 * DPS panels are currently in the layout.
 */
export function DpsFeedProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [feed] = useState(() => new DpsFeed())

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets) => feed.ingest(packets))
    const offDetach = window.overlay.onOverlayDetach(() => feed.detach())
    return () => {
      offBatch()
      offDetach()
    }
  }, [feed])

  return <DpsFeedContext.Provider value={feed}>{children}</DpsFeedContext.Provider>
}
