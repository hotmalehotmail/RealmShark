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
  const [actionMsg, setActionMsg] = useState('')

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
      setActionMsg('')
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
    setActionMsg('')
    const info = await window.overlay.checkForUpdate()
    setUpdate(info)
    if (!info) setActionMsg('Up to date')
    setChecking(false)
  }

  const installUpdate = (): void => {
    setDownloadPct(0)
    void window.overlay.downloadUpdate() // app restarts itself when the installer runs
  }

  const reportBug = async (): Promise<void> => {
    setActionMsg('Capturing…')
    try {
      await window.overlay.reportBug()
      setActionMsg('Capture saved — drag it into the issue')
    } catch {
      setActionMsg('Capture failed')
    }
  }

  const captureNow = async (): Promise<void> => {
    setActionMsg('Capturing…')
    try {
      await window.overlay.captureNow()
      setActionMsg('Capture saved to disk')
    } catch {
      setActionMsg('Capture failed')
    }
  }

  // Single message slot below the action row (rather than one message per
  // button) so the actions stay pinned to the bottom edge at a fixed height,
  // and the latest fired action's message always wins - see
  // docs/overlay-renderer.md.

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
        <>
          <div className="mt-1 text-2xs text-fg-faint">
            {toggleHotkey} to return input to the game
          </div>

          <div className="mt-1.5 border-t border-edge pt-1">
            <StatRow label="Packets seen">{packetCount}</StatRow>
            <StatRow label="Memory" className="pt-0.5">
              {heapMb === null ? 'n/a' : `${heapMb.toFixed(1)} MB`}
            </StatRow>
          </div>

          {size === 'lg' && lastPacket && (
            <div className="mt-1 truncate text-2xs text-fg-faint">
              last: {lastPacket.direction} {lastPacket.type}
            </div>
          )}

          {/* Pinned to the panel's bottom edge (mt-auto) so every action stays
              reachable without scrolling regardless of how much info sits above it. */}
          <div className="mt-auto border-t border-edge pt-1.5">
            {update && (
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate text-2xs text-success">v{update.version} available</span>
                {downloadPct != null && (
                  <span className="shrink-0 text-2xs text-fg-muted">{downloadPct}%…</span>
                )}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              {downloadPct == null && update && (
                <Button variant="success" size="xs" onClick={installUpdate}>
                  Update &amp; restart
                </Button>
              )}
              {downloadPct == null && (
                <Button size="xs" onClick={checkUpdates} disabled={checking}>
                  {checking ? 'Checking…' : update ? 'Check again' : 'Check for updates'}
                </Button>
              )}
              <Button size="xs" onClick={reportBug}>
                Report bug
              </Button>
              <Button size="xs" onClick={captureNow}>
                Capture now
              </Button>
            </div>
            {actionMsg && <div className="mt-0.5 truncate text-2xs text-fg-faint">{actionMsg}</div>}
          </div>
        </>
      )}
    </div>
  )
}

export default StatusPanel
