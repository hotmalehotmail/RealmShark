import { useEffect, useState } from 'react'
import type { BridgeStatus, PacketEnvelope, UpdateInfo } from '../../../shared/ipc'
import { DEFAULT_SETTINGS } from '../../../shared/settings'
import { Button } from '../ui/Button'
import { StatRow } from '../ui/StatRow'
import type { PanelContentProps } from './registry'

const STATUS_STYLES: Record<BridgeStatus, string> = {
  connected: 'bg-success',
  connecting: 'bg-warn',
  disconnected: 'bg-danger'
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
  const [captureMsg, setCaptureMsg] = useState('')

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
    const offUpdate = window.overlay.onUpdateAvailable((info) => {
      setUpdate(info)
      setCheckMsg('')
    })
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

  const captureNow = async (): Promise<void> => {
    setCaptureMsg('Capturing…')
    try {
      await window.overlay.captureNow()
      setCaptureMsg('Capture saved to disk')
    } catch {
      setCaptureMsg('Capture failed')
    }
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center justify-between">
        <span className="flex items-baseline gap-1.5">
          <span className="font-semibold tracking-wide">RealmShark</span>
          {version && <span className="font-mono text-xs text-fg-faint">v{version}</span>}
        </span>
        <span className="flex items-center gap-1.5 text-xs text-fg-muted">
          <span className={`h-2 w-2 rounded-full ${STATUS_STYLES[status]}`} />
          {status}
        </span>
      </div>

      {size !== 'sm' && (
        <div className="mt-2 text-xs text-fg-faint">{toggleHotkey} to return input to the game</div>
      )}

      {size !== 'sm' && (
        <StatRow label="Packets seen" className="mt-3 border-t border-edge pt-2">
          {packetCount}
        </StatRow>
      )}

      {size !== 'sm' && (
        <StatRow label="Memory" className="pt-1">
          {heapMb === null ? 'n/a' : `${heapMb.toFixed(1)} MB`}
        </StatRow>
      )}

      {size !== 'sm' && (
        <div className="mt-3 border-t border-edge pt-2">
          {update && (
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs text-success">
                Update available → v{update.version}
              </span>
              {downloadPct == null ? (
                <Button variant="success" className="shrink-0" onClick={installUpdate}>
                  Update &amp; restart
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-fg-muted">Downloading {downloadPct}%…</span>
              )}
            </div>
          )}
          {downloadPct == null && (
            <div className={`flex items-center justify-between gap-2 ${update ? 'mt-1' : ''}`}>
              <Button className="shrink-0" onClick={checkUpdates} disabled={checking}>
                {checking ? 'Checking…' : update ? 'Check again' : 'Check for updates'}
              </Button>
              {checkMsg && <span className="text-xs text-fg-faint">{checkMsg}</span>}
            </div>
          )}
        </div>
      )}

      {size !== 'sm' && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <Button className="shrink-0" onClick={reportBug}>
            Report bug
          </Button>
          {bugMsg && <span className="truncate text-xs text-fg-faint">{bugMsg}</span>}
        </div>
      )}

      {size !== 'sm' && (
        <div className="mt-1 flex items-center justify-between gap-2">
          <Button className="shrink-0" onClick={captureNow}>
            Capture now
          </Button>
          {captureMsg && <span className="truncate text-xs text-fg-faint">{captureMsg}</span>}
        </div>
      )}

      {size === 'lg' && lastPacket && (
        <div className="mt-1 truncate text-xs text-fg-faint">
          last: {lastPacket.direction} {lastPacket.type}
        </div>
      )}
    </div>
  )
}

export default StatusPanel
