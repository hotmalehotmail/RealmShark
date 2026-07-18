import { useEffect, useState } from 'react'
import { AlertEngine } from './AlertEngine'

/**
 * Mounts a single `AlertEngine` instance at App level (PRD §2: "mounted once
 * at App level ... because banners and sounds must fire even when no panel
 * is open") and wires it to the same packet/settings/detach IPC every
 * per-panel tracker uses (`useLootTracker.ts`'s pattern, plus the settings
 * plumbing `useDpsTracker`-style hooks don't need). `useState(() => ...)`
 * keeps the engine a stable singleton across re-renders.
 * <p>
 * Issue #218 ships no UI - nothing yet reads this hook's return value inside
 * `App.tsx` beyond mounting it for its side effects (ingesting packets,
 * evaluating the catalog, appending to `engine.store`). Future issues (#219
 * banner host, #220 history panel, #221 settings gear) consume
 * `engine.store`'s subscribe API directly; whichever lands first can wrap
 * this hook's return value in a context without touching the engine itself.
 */
export function useAlertEngine(): AlertEngine {
  const [engine] = useState(() => new AlertEngine())

  useEffect(() => {
    window.overlay.getSettings().then((settings) => engine.setSettings(settings.notifications))
    const offSettings = window.overlay.onSettingsChanged((settings) => {
      engine.setSettings(settings.notifications)
    })
    const offBatch = window.overlay.onPacketBatch((packets) => engine.ingest(packets))
    const offDetach = window.overlay.onOverlayDetach(() => engine.reset())
    return () => {
      offSettings()
      offBatch()
      offDetach()
    }
  }, [engine])

  return engine
}
