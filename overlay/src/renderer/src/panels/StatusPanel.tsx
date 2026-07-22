import { useEffect, useState } from 'react'
import type { ChatProbeStatus } from '../../../shared/chatProbe'
import type { BridgeStatus, PacketEnvelope, UpdateInfo } from '../../../shared/ipc'
import { DEFAULT_SETTINGS, isDevModeActive } from '../../../shared/settings'
import { Button } from '../ui/Button'
import { StatRow } from '../ui/StatRow'
import { usePanelSpawn } from './panelSpawn'
import { PANEL_REGISTRY, type PanelContentProps } from './registry'

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

/**
 * The Status panel's toggle list covers every singleton panel: everything in
 * the registry except status itself (not closable - this list is the way
 * back), ephemeral panels (dpsDetail is opened from a DPS Summary row
 * click with a selected session; toggling an empty one on from here would be
 * meaningless), and - while dev mode is off (issue #265, docs/dev-mode.md) -
 * `debugOnly` panels (the Console), so an ordinary user never sees it in the
 * picker even though its instance may still exist in their layout. Computed
 * at render time, not module scope: registry.ts imports this component, so
 * reading PANEL_REGISTRY during module evaluation would hit the circular
 * import before the registry is initialized.
 */
function togglablePanels(devMode: boolean): { type: string; title: string }[] {
  return Object.values(PANEL_REGISTRY)
    .filter((spec) => spec.closable && !spec.ephemeral && (devMode || !spec.debugOnly))
    .map(({ type, title }) => ({ type, title }))
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
  const [probe, setProbe] = useState<ChatProbeStatus>({ active: false, captured: 0 })
  const [devMode, setDevMode] = useState(false)
  const { openPanel, closePanel, isOpen } = usePanelSpawn()

  // Dev mode active = the machine-local unlock AND the persisted toggle
  // (issue #265/#266, docs/dev-mode.md) - gates the debugOnly entries in the
  // panel toggle list below and the diagnostic internals further down (chat
  // probe, last-packet line).
  useEffect(() => {
    window.overlay.getSettings().then((s) => setDevMode(isDevModeActive(s)))
    const off = window.overlay.onSettingsChanged((s) => setDevMode(isDevModeActive(s)))
    return () => off()
  }, [])

  useEffect(() => {
    window.overlay.getSettings().then((settings) => setToggleHotkey(settings.toggleHotkey))
    window.overlay.getAppVersion().then(setVersion)
    window.overlay.getBridgeStatus().then(setStatus)
    window.overlay.getUpdateStatus().then(setUpdate)
    window.overlay.getChatProbeStatus().then(setProbe)
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

  // Live captured-count in the button label while the probe is armed, so a
  // test message sent in-game gives immediate "the packet arrived" feedback
  // without stopping the probe. Separate from the always-on memory interval:
  // this one exists only while armed.
  useEffect(() => {
    if (!probe.active) return
    const interval = setInterval(
      () => window.overlay.getChatProbeStatus().then(setProbe),
      MEMORY_POLL_MS
    )
    return () => clearInterval(interval)
  }, [probe.active])

  const toggleChatProbe = async (): Promise<void> => {
    if (probe.active) {
      const result = await window.overlay.stopChatProbe()
      setProbe({ active: false, captured: 0 })
      setActionMsg(
        result.file
          ? `Chat probe: ${result.captured} envelopes saved (folder opened)`
          : 'Chat probe: nothing captured'
      )
    } else {
      setProbe(await window.overlay.startChatProbe())
      setActionMsg('Chat probe armed — send test messages in game')
    }
  }

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

          {devMode && size === 'lg' && lastPacket && (
            <div className="mt-1 truncate text-2xs text-fg-faint">
              last: {lastPacket.direction} {lastPacket.type}
            </div>
          )}

          {/* Singleton panels use id === type (the defaultLayout() invariant),
              so the registry type doubles as the instance id here. Ghost+active
              matches the pin toggle's engaged-state styling: green = shown,
              faint = hidden. */}
          <div className="mt-1.5 border-t border-edge pt-1">
            <div className="text-2xs uppercase tracking-wide text-fg-faint">Panels</div>
            <div className="mt-0.5 flex flex-wrap gap-x-1 gap-y-0.5">
              {togglablePanels(devMode).map(({ type, title }) => {
                const open = isOpen(type)
                return (
                  <Button
                    key={type}
                    variant="ghost"
                    size="xs"
                    active={open}
                    onClick={() => (open ? closePanel(type) : openPanel(type, type, 'md'))}
                    title={open ? `Hide the ${title} panel` : `Show the ${title} panel`}
                  >
                    {title}
                  </Button>
                )
              })}
            </div>
          </div>

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
              {devMode && (
                <Button
                  size="xs"
                  variant={probe.active ? 'warn' : 'subtle'}
                  onClick={toggleChatProbe}
                  title={
                    probe.active
                      ? 'Stop the chat probe and write the captured envelopes to a local NDJSON file'
                      : 'Capture chat/party packets to a LOCAL file for wire-shape diagnosis (issue #222) — this data is never part of bug captures'
                  }
                >
                  {probe.active ? `Stop probe (${probe.captured})` : 'Chat probe'}
                </Button>
              )}
            </div>
            {actionMsg && <div className="mt-0.5 truncate text-2xs text-fg-faint">{actionMsg}</div>}
          </div>
        </>
      )}
    </div>
  )
}

export default StatusPanel
