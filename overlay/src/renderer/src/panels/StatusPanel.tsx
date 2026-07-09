import { useEffect, useState } from 'react'
import type { BridgeStatus, PacketEnvelope } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { PanelContentProps } from './registry'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  disconnected: 'bg-red-500'
}

function StatusPanel({ size }: PanelContentProps): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>('connecting')
  const [packetCount, setPacketCount] = useState(0)
  const [lastPacket, setLastPacket] = useState<PacketEnvelope | null>(null)
  const [toggleHotkey, setToggleHotkey] = useState(DEFAULT_SETTINGS.toggleHotkey)

  useEffect(() => {
    window.overlay.getSettings().then((settings) => setToggleHotkey(settings.toggleHotkey))
    window.overlay.getBridgeStatus().then(setStatus)
    const offStatus = window.overlay.onBridgeStatus(setStatus)
    const offBatch = window.overlay.onPacketBatch((packets) => {
      setPacketCount((n) => n + packets.length)
      if (packets.length > 0) setLastPacket(packets[packets.length - 1])
    })
    return () => {
      offStatus()
      offBatch()
    }
  }, [])

  return (
    <div className="flex h-full w-full flex-col text-sm text-white">
      <div className="flex items-center justify-between">
        <span className="font-semibold tracking-wide">RealmShark</span>
        <span className="flex items-center gap-1.5 text-xs text-white/70">
          <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
          {status}
        </span>
      </div>

      {size !== 'sm' && (
        <div className="mt-2 text-xs text-white/50">{toggleHotkey} to return input to the game</div>
      )}

      {size !== 'sm' && (
        <div className="mt-3 flex items-baseline justify-between border-t border-white/10 pt-2">
          <span className="text-white/60">Packets seen</span>
          <span className="font-mono text-base">{packetCount}</span>
        </div>
      )}

      {size === 'lg' && lastPacket && (
        <div className="mt-1 truncate text-xs text-white/40">
          last: {lastPacket.direction} {lastPacket.type}
        </div>
      )}
    </div>
  )
}

export default StatusPanel
