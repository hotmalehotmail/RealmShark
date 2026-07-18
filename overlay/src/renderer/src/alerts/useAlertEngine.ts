import { useEffect, useState } from 'react'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { AlertEngine } from './AlertEngine'

export interface AlertEngineHandle {
  engine: AlertEngine
  /** Live `NotificationsSettings.volume` (0..1) - `AlertToastHost` (issue #219) forwards this to `pingPlayer` unchanged. */
  volume: number
}

/**
 * Mounts a single `AlertEngine` instance at App level (PRD §2: "mounted once
 * at App level ... because banners and sounds must fire even when no panel
 * is open") and wires it to the same packet/settings/detach IPC every
 * per-panel tracker uses (`useLootTracker.ts`'s pattern, plus the settings
 * plumbing `useDpsTracker`-style hooks don't need). `useState(() => ...)`
 * keeps the engine a stable singleton across re-renders.
 * <p>
 * Also tracks the live `notifications.volume` setting alongside the engine
 * (same `getSettings`/`onSettingsChanged` subscription the engine itself
 * uses) so `App.tsx` can forward it to `AlertToastHost` (issue #219) without
 * a second, duplicate settings subscription.
 */
export function useAlertEngine(): AlertEngineHandle {
  const [engine] = useState(() => new AlertEngine())
  const [volume, setVolume] = useState(DEFAULT_SETTINGS.notifications.volume)

  useEffect(() => {
    window.overlay.getSettings().then((settings) => {
      engine.setSettings(settings.notifications)
      setVolume(settings.notifications.volume)
    })
    const offSettings = window.overlay.onSettingsChanged((settings) => {
      engine.setSettings(settings.notifications)
      setVolume(settings.notifications.volume)
    })
    const offBatch = window.overlay.onPacketBatch((packets) => engine.ingest(packets))
    const offDetach = window.overlay.onOverlayDetach(() => engine.reset())
    return () => {
      offSettings()
      offBatch()
      offDetach()
    }
  }, [engine])

  return { engine, volume }
}
