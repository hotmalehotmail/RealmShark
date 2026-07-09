import { useEffect, useRef, useState } from 'react'
import type { BridgeStatus } from '../../shared/ipc'
import PanelCanvas from './panels/PanelCanvas'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  disconnected: 'bg-red-500'
}

const ATTACH_TOAST_MS = 2500

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
    return () => {
      offStatus()
      offInteractive()
      offAttach()
      clearTimeout(attachToastTimer.current)
    }
  }, [])

  return (
    <div className="relative h-screen w-screen">
      {showAttachToast && !interactive && (
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/80 px-4 py-2 text-sm text-white shadow-lg backdrop-blur-sm">
            <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
            RealmShark attached
          </div>
        </div>
      )}

      {interactive && <PanelCanvas />}
    </div>
  )
}

export default App
