import { useEffect, useRef, useState } from 'react'
import type { BridgeStatus } from '../../shared/ipc'
import { AlertToastHost } from './alerts/AlertToastHost'
import { AlertStoreContext } from './alerts/alertStoreContext'
import type { FiredAlertStore } from './alerts/store'
import { useAlertEngine } from './alerts/useAlertEngine'
import { ingestMainEntry } from './consoleLog'
import { DpsDetailSelectionProvider } from './dps/DpsDetailSelectionProvider'
import { ItemInfoProvider } from './items/ItemInfoProvider'
import PanelCanvas from './panels/PanelCanvas'
import { EntityRegistryProvider } from './sprites/EntityRegistry'
import { SpriteProvider } from './sprites/SpriteProvider'
import { InteractiveContext } from './ui/interactiveContext'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-warn',
  disconnected: 'bg-danger'
}

const ATTACH_TOAST_MS = 2500

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>('connecting')
  const [interactive, setInteractive] = useState(false)
  const [showAttachToast, setShowAttachToast] = useState(false)
  const attachToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Mounted once at App level, not inside a panel (PRD §2 of
  // docs/prd-notifications.md) - `engine.store` feeds `AlertToastHost` below
  // (issue #219); future issues (#220 history panel, #221 settings gear)
  // read the same store/settings without touching the engine itself.
  const { engine: alertEngine, volume: alertVolume } = useAlertEngine()

  useEffect(() => {
    window.overlay.getBridgeStatus().then(setStatus)
    const offStatus = window.overlay.onBridgeStatus(setStatus)
    const offInteractive = window.overlay.onInteractiveChange(setInteractive)
    const offAttach = window.overlay.onAttachSuccess(() => {
      setShowAttachToast(true)
      clearTimeout(attachToastTimer.current)
      attachToastTimer.current = setTimeout(() => setShowAttachToast(false), ATTACH_TOAST_MS)
    })

    // Backfill anything the main process logged before this window existed
    // (e.g. the bridge-supervisor spawn line), then keep streaming.
    window.overlay.getBufferedMainLogs().then((entries) => entries.forEach(ingestMainEntry))
    const offMainLog = window.overlay.onMainLogEntry(ingestMainEntry)

    // Backfill the bridge's one-shot metadata tables the same way (issue
    // #245): when the supervisor finds an already-running bridge, the WS can
    // connect and deliver them before this render tree's subscribers exist.
    // App's own effect runs after every descendant's (React flushes effects
    // bottom-up), so all packet consumers are subscribed by now; a table
    // that DID arrive normally is re-skipped by its metaVersion.
    void window.overlay.replayMetadata()

    return () => {
      offStatus()
      offInteractive()
      offAttach()
      offMainLog()
      clearTimeout(attachToastTimer.current)
    }
  }, [])

  // Tell the main process whether a text-editable element has focus, so its
  // global Esc-dismiss handler (main/index.ts) can skip while a panel's own
  // Esc affordance - e.g. ConsolePanel clearing its search box - should
  // handle the key instead of the whole overlay dismissing to click-through.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent): void => {
      if (isEditableTarget(e.target)) window.overlay.setEditableFocused(true)
    }
    const onFocusOut = (e: FocusEvent): void => {
      if (isEditableTarget(e.target)) window.overlay.setEditableFocused(false)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
    }
  }, [])

  return (
    <SpriteProvider>
      <EntityRegistryProvider>
        <ItemInfoProvider>
          <DpsDetailSelectionProvider>
            <InteractiveContext.Provider value={interactive}>
              {/* Issue #220: lets NotificationsPanel (mounted deep under
                  PanelCanvas, no direct parent/child relationship to App)
                  read the same store AlertToastHost gets as a prop below,
                  without reaching into AlertEngine internals. */}
              <AlertStoreContext.Provider value={alertEngine.store}>
                <AppShell
                  status={status}
                  interactive={interactive}
                  showAttachToast={showAttachToast}
                  alertStore={alertEngine.store}
                  alertVolume={alertVolume}
                />
              </AlertStoreContext.Provider>
            </InteractiveContext.Provider>
          </DpsDetailSelectionProvider>
        </ItemInfoProvider>
      </EntityRegistryProvider>
    </SpriteProvider>
  )
}

interface AppShellProps {
  status: BridgeStatus
  interactive: boolean
  showAttachToast: boolean
  alertStore: FiredAlertStore
  alertVolume: number
}

function AppShell({
  status,
  interactive,
  showAttachToast,
  alertStore,
  alertVolume
}: AppShellProps): React.JSX.Element {
  return (
    <div className="relative h-screen w-screen">
      {/* Above PanelCanvas (PRD §4) - visible in both interactive and hidden
          mode, same rationale as pinned panels: banners/pings must fire
          mid-gameplay whether or not the overlay is currently shown. */}
      <AlertToastHost store={alertStore} interactive={interactive} volume={alertVolume} />

      {showAttachToast && !interactive && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-edge bg-panel px-4 py-2 text-sm text-fg shadow-lg backdrop-blur-sm">
            <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
            RealmShark attached
          </div>
        </div>
      )}

      {/* Dim backdrop: rendered only in interactive mode to visibly darken the
          game behind the overlay and signal that input is being captured. It's
          gated on interactive alone (never shown just because a pinned panel is
          visible), and rendered before the panel canvas with no positive
          z-index, so the positioned panels paint on top and stay crisp -- only
          the game behind is dimmed. */}
      {interactive && <div className="absolute inset-0 bg-scrim" />}

      {/* Always mounted (never conditionally rendered) - panels hold live
          state (packet counter, the DPS tracker's whole session) that must
          survive toggling interactive mode on and off. Visibility is now
          per-panel: in interactive mode every panel shows and is draggable;
          when hidden, only pinned panels remain (as display-only,
          pointer-events-none boxes). See PanelFrame. */}
      <PanelCanvas interactive={interactive} />
    </div>
  )
}

export default App
