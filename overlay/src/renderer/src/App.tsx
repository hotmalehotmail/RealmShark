import { useEffect, useState } from 'react'
import type { BridgeStatus, PacketEnvelope } from '../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../shared/settings'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  disconnected: 'bg-red-500'
}

function App(): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>('connecting')
  const [interactive, setInteractive] = useState(false)
  const [packetCount, setPacketCount] = useState(0)
  const [lastPacket, setLastPacket] = useState<PacketEnvelope | null>(null)
  const [toggleHotkey, setToggleHotkey] = useState(DEFAULT_SETTINGS.toggleHotkey)

  useEffect(() => {
    window.overlay.getSettings().then((settings) => setToggleHotkey(settings.toggleHotkey))
    const offStatus = window.overlay.onBridgeStatus(setStatus)
    const offInteractive = window.overlay.onInteractiveChange(setInteractive)
    const offBatch = window.overlay.onPacketBatch((packets) => {
      setPacketCount((n) => n + packets.length)
      if (packets.length > 0) setLastPacket(packets[packets.length - 1])
    })
    return () => {
      offStatus()
      offInteractive()
      offBatch()
    }
  }, [])

  return (
    <div className="flex h-screen w-screen items-start justify-start p-4">
      <div
        className={`w-72 rounded-lg border border-white/10 bg-black/70 p-3 text-sm text-white shadow-lg backdrop-blur-sm ${
          interactive ? 'ring-2 ring-sky-400' : ''
        }`}
      >
        <div className="flex items-center justify-between">
          <span className="font-semibold tracking-wide">RealmShark</span>
          <span className="flex items-center gap-1.5 text-xs text-white/70">
            <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
            {status}
          </span>
        </div>

        <div className="mt-2 text-xs text-white/50">
          {toggleHotkey} to {interactive ? 'return input to the game' : 'interact with the overlay'}
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
    </div>
  )
}

export default App
