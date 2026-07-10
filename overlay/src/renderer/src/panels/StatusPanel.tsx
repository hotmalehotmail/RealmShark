import { useEffect, useState } from 'react'
import type { BridgeStatus, PacketEnvelope, UpdateInfo } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import type { PanelContentProps } from './registry'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-emerald-500',
  connecting: 'bg-amber-400',
  disconnected: 'bg-red-500'
}

const MEMORY_POLL_MS = 1000

/** Chrome/Electron-only, non-standard - not in lib.dom.d.ts. */
interface PerformanceMemory {
  usedJSHeapSize: number
}

function usedJsHeapMb(): number | null {
  const memory = (performance as Performance & { memory?: PerformanceMemory }).memory
  return memory ? memory.usedJSHeapSize / (1024 * 1024) : null
}

function StatusPanel({ size }: PanelContentProps): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus>('connecting')
  const [packetCount, setPacketCount] = useState(0)
  const [lastPacket, setLastPacket] = useState<PacketEnvelope | null>(null)
  const [toggleHotkey, setToggleHotkey] = useState(DEFAULT_SETTINGS.toggleHotkey)
  const [heapMb, setHeapMb] = useState<number | null>(() => usedJsHeapMb())
  const [version, setVersion] = useState('')
  const [update, setUpdate] = useState<UpdateInfo | null>(null)
  const [checking, setChecking] = useState(false)
  const [downloadPct, setDownloadPct] = useState<number | null>(null)
  const [checkMsg, setCheckMsg] = useState('')
  const [bugMsg, setBugMsg] = useState('')

  useEffect(() => {
    window.overlay.getSettings().then((settings) => setToggleHotkey(settings.toggleHotkey))
    window.overlay.getAppVersion().then(setVersion)
    window.overlay.getBridgeStatus().then(setStatus)
    window.overlay.getUpdateStatus().then(setUpdate)
    const offStatus = window.overlay.onBridgeStatus(setStatus)
    const offBatch = window.overlay.onPacketBatch((packets) => {
      setPacketCount((n) => n + packets.length)
      if (packets.length > 0) setLastPacket(packets[packets.length - 1])
    })
    const offUpdate = window.overlay.onUpdateAvailable(setUpdate)
    const offProgress = window.overlay.onUpdateProgress(({ received, total }) =>
      setDownloadPct(total > 0 ? Math.round((received / total) * 100) : 0)
    )
    const memoryInterval = setInterval(() => setHeapMb(usedJsHeapMb()), MEMORY_POLL_MS)
    return () => {
      offStatus()
      offBatch()
      offUpdate()
      offProgress()
      clearInterval(memoryInterval)
    }
  }, [])

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    setCheckMsg('')
    const info = await window.overlay.checkForUpdate()
    setUpdate(info)
    if (!info) setCheckMsg('Up to date')
    setChecking(false)
  }

  const installUpdate = (): void => {
    setDownloadPct(0)
    void window.overlay.downloadUpdate() // app restarts itself when the installer runs
  }

  const reportBug = async (): Promise<void> => {
    setBugMsg('Capturing…')
    try {
      await window.overlay.reportBug()
      setBugMsg('Capture saved — drag it into the issue')
    } catch {
      setBugMsg('Capture failed')
    }
  }

  return (
    <div className="flex h-full w-full flex-col text-sm text-white">
      <div className="flex items-center justify-between">
        <span className="flex items-baseline gap-1.5">
          <span className="font-semibold tracking-wide">RealmShark</span>
          {version && <span className="text-xs text-white/40 font-mono">v{version}</span>}
        </span>
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

      {size !== 'sm' && (
        <div className="flex items-baseline justify-between pt-1">
          <span className="text-white/60">Memory</span>
          <span className="font-mono text-base">
            {heapMb === null ? 'n/a' : `${heapMb.toFixed(1)} MB`}
          </span>
        </div>
      )}

      {size !== 'sm' && (
        <div className="mt-3 border-t border-white/10 pt-2">
          {update ? (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-emerald-400">
                Update available → v{update.version}
              </span>
              {downloadPct == null ? (
                <button
                  onClick={installUpdate}
                  className="shrink-0 rounded bg-emerald-600 px-2 py-0.5 text-xs font-medium hover:bg-emerald-500"
                >
                  Update &amp; restart
                </button>
              ) : (
                <span className="shrink-0 text-xs text-white/60">Downloading {downloadPct}%…</span>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2">
              <button
                onClick={checkUpdates}
                disabled={checking}
                className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20 disabled:opacity-50"
              >
                {checking ? 'Checking…' : 'Check for updates'}
              </button>
              {checkMsg && <span className="text-xs text-white/40">{checkMsg}</span>}
            </div>
          )}
        </div>
      )}

      {size !== 'sm' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <button
            onClick={reportBug}
            className="shrink-0 rounded bg-white/10 px-2 py-0.5 text-xs hover:bg-white/20"
          >
            Report bug
          </button>
          {bugMsg && <span className="truncate text-xs text-white/40">{bugMsg}</span>}
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
