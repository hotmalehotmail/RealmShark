import { useEffect, useRef, useState } from 'react'
import type { BridgeStatus, PacketEnvelope } from '../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  disconnected: 'bg-red-500'
}

const ATTACH_TOAST_MS = 2500

function App(): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>('connecting')
  const [interactive, setInteractive] = useState(false)
  const [packetCount, setPacketCount] = useState(0)
  const [lastPacket, setLastPacket] = useState<PacketEnvelope | null>(null)
  const [toggleHotkey, setToggleHotkey] = useState(DEFAULT_SETTINGS.toggleHotkey)
  const [showAttachToast, setShowAttachToast] = useState(false)
  const attachToastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    window.overlay.getSettings().then((settings) => setToggleHotkey(settings.toggleHotkey))
    // The bridge can connect before this window finishes loading and registers
    // onBridgeStatus below, so pull the current status directly rather than
    // relying solely on catching the one-shot push.
    window.overlay.getBridgeStatus().then(setStatus)
    const offStatus = window.overlay.onBridgeStatus(setStatus)
    const offInteractive = window.overlay.onInteractiveChange(setInteractive)
    const offBatch = window.overlay.onPacketBatch((packets) => {
      setPacketCount((n) => n + packets.length)
      if (packets.length > 0) setLastPacket(packets[packets.length - 1])
    })
    const offAttach = window.overlay.onAttachSuccess(() => {
      setShowAttachToast(true)
      clearTimeout(attachToastTimer.current)
      attachToastTimer.current = setTimeout(() => setShowAttachToast(false), ATTACH_TOAST_MS)
    })
    return () => {
      offStatus()
      offInteractive()
      offBatch()
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

      {interactive && (
        <div className="absolute left-4 top-4 w-72 rounded-lg border border-white/10 bg-black/70 p-3 text-sm text-white shadow-lg ring-2 ring-sky-400 backdrop-blur-sm">
          <div className="flex items-center justify-between">
            <span className="font-semibold tracking-wide">RealmShark</span>
            <span className="flex items-center gap-1.5 text-xs text-white/70">
              <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
              {status}
            </span>
          </div>

          <div className="mt-2 text-xs text-white/50">
            {toggleHotkey} to return input to the game
          </div>

          <div className="mt-3 flex items-baseline justify-between border-t border-white/10 pt-2">
            <span className="text-white/60">Packets seen</span>
            <span className="font-mono text-base">{packetCount}</span>
          </div>

          {lastPacket && (
            <div className="mt-1 truncate text-xs text-white/40">
              last: {lastPacket.direction} {lastPacket.type}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default App
