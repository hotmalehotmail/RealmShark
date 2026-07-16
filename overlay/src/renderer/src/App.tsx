import { useEffect, useRef, useState } from 'react'
import type { BridgeStatus } from '../../shared/ipc'
import { ingestMainEntry } from './consoleLog'
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
          <InteractiveContext.Provider value={interactive}>
            <AppShell status={status} interactive={interactive} showAttachToast={showAttachToast} />
          </InteractiveContext.Provider>
        </ItemInfoProvider>
      </EntityRegistryProvider>
    </SpriteProvider>
  )
}

interface AppShellProps {
  status: BridgeStatus
  interactive: boolean
  showAttachToast: boolean
}

function AppShell({ status, interactive, showAttachToast }: AppShellProps): React.JSX.Element {
  return (
    <div className="relative h-screen w-screen">
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
