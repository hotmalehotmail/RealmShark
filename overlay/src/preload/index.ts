import { contextBridge, ipcRenderer } from 'electron'
import type { ChatProbeResult, ChatProbeStatus } from '../shared/chatProbe'
import {
  IPC,
  type BridgeStatus,
  type BugReportResult,
  type MainLogEntry,
  type PacketEnvelope,
  type SaveSettingsResult,
  type SpritePack,
  type UpdateInfo,
  type UpdateProgress
} from '../shared/ipc'
import type { OverlayApi } from '../shared/overlayApi'
import type { PanelInstance } from '../shared/panels'
import type { OverlaySettings } from '../shared/settings'

// The packet stream is a fan-out: every consumer (StatusPanel, EntityRegistry,
// useDpsTracker, useLootTracker, …) registers its own onPacketBatch listener,
// each triggering its own re-render off the same batches. During a panel drag
// those re-renders compete with the drag for the main thread, so delivery can
// be suspended (buffered, not dropped) for the duration - see
// setPacketBatchSuspended, called from PanelFrame's drag handlers, and the
// interactive-change/overlay-detach failsafe below it that guards against a
// lost mouseup. Buffered batches are merged and delivered as one batch when
// delivery resumes.
let packetDeliverySuspended = false
let suspendedBatches: PacketEnvelope[][] = []
const packetBatchListeners = new Set<(packets: PacketEnvelope[]) => void>()

ipcRenderer.on(IPC.packetBatch, (_: unknown, packets: PacketEnvelope[]) => {
  if (packetDeliverySuspended) {
    suspendedBatches.push(packets)
    return
  }
  for (const listener of packetBatchListeners) listener(packets)
})

function setPacketBatchSuspended(suspended: boolean): void {
  packetDeliverySuspended = suspended
  if (!suspended && suspendedBatches.length > 0) {
    const merged = suspendedBatches.flat()
    suspendedBatches = []
    for (const listener of packetBatchListeners) listener(merged)
  }
}

// Failsafe: a drag normally resumes delivery itself on mouseup
// (PanelFrame.tsx), but a lost mouseup (overlay toggled out of interactive
// mode mid-drag via the hotkey, or the game/overlay closing) would otherwise
// leave every consumer (DPS/loot/entity-registry/status) frozen forever.
// Force-resume on both signals so a stuck drag can't permanently wedge the
// packet stream.
ipcRenderer.on(IPC.interactiveChange, (_: unknown, interactive: boolean) => {
  if (!interactive) setPacketBatchSuspended(false)
})
ipcRenderer.on(IPC.overlayDetach, () => setPacketBatchSuspended(false))

const overlayApi: OverlayApi = {
  onBridgeStatus: (cb: (status: BridgeStatus) => void) => {
    const listener = (_: unknown, status: BridgeStatus): void => cb(status)
    ipcRenderer.on(IPC.bridgeStatus, listener)
    return () => ipcRenderer.removeListener(IPC.bridgeStatus, listener)
  },
  onPacketBatch: (cb: (packets: PacketEnvelope[]) => void) => {
    packetBatchListeners.add(cb)
    return () => packetBatchListeners.delete(cb)
  },
  /** See the fan-out comment above. */
  setPacketBatchSuspended,
  onInteractiveChange: (cb: (interactive: boolean) => void) => {
    const listener = (_: unknown, interactive: boolean): void => cb(interactive)
    ipcRenderer.on(IPC.interactiveChange, listener)
    return () => ipcRenderer.removeListener(IPC.interactiveChange, listener)
  },
  onAttachSuccess: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.attachSuccess, listener)
    return () => ipcRenderer.removeListener(IPC.attachSuccess, listener)
  },
  onOverlayDetach: (cb: () => void) => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.overlayDetach, listener)
    return () => ipcRenderer.removeListener(IPC.overlayDetach, listener)
  },
  getBridgeStatus: (): Promise<BridgeStatus> => ipcRenderer.invoke(IPC.getBridgeStatus),
  getSettings: (): Promise<OverlaySettings> => ipcRenderer.invoke(IPC.getSettings),
  onSettingsChanged: (cb: (settings: OverlaySettings) => void) => {
    const listener = (_: unknown, settings: OverlaySettings): void => cb(settings)
    ipcRenderer.on(IPC.settingsChanged, listener)
    return () => ipcRenderer.removeListener(IPC.settingsChanged, listener)
  },
  getAppVersion: (): Promise<string> => ipcRenderer.invoke(IPC.getAppVersion),
  saveSettings: (settings: OverlaySettings): Promise<SaveSettingsResult> =>
    ipcRenderer.invoke(IPC.saveSettings, settings),
  relaunch: (): Promise<void> => ipcRenderer.invoke(IPC.relaunch),
  getPanelLayout: (): Promise<PanelInstance[] | null> => ipcRenderer.invoke(IPC.getPanelLayout),
  savePanelLayout: (panels: PanelInstance[]): Promise<void> =>
    ipcRenderer.invoke(IPC.savePanelLayout, panels),
  onMainLogEntry: (cb: (entry: MainLogEntry) => void) => {
    const listener = (_: unknown, entry: MainLogEntry): void => cb(entry)
    ipcRenderer.on(IPC.mainLogEntry, listener)
    return () => ipcRenderer.removeListener(IPC.mainLogEntry, listener)
  },
  getBufferedMainLogs: (): Promise<MainLogEntry[]> => ipcRenderer.invoke(IPC.getBufferedMainLogs),
  getSpritePack: (): Promise<SpritePack> => ipcRenderer.invoke(IPC.getSpritePack),
  onSpritePack: (cb: (pack: SpritePack) => void) => {
    const listener = (_: unknown, pack: SpritePack): void => cb(pack)
    ipcRenderer.on(IPC.spritePack, listener)
    return () => ipcRenderer.removeListener(IPC.spritePack, listener)
  },
  getUpdateStatus: (): Promise<UpdateInfo | null> => ipcRenderer.invoke(IPC.getUpdateStatus),
  checkForUpdate: (): Promise<UpdateInfo | null> => ipcRenderer.invoke(IPC.checkForUpdate),
  downloadUpdate: (): Promise<void> => ipcRenderer.invoke(IPC.downloadUpdate),
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => {
    const listener = (_: unknown, info: UpdateInfo): void => cb(info)
    ipcRenderer.on(IPC.updateAvailable, listener)
    return () => ipcRenderer.removeListener(IPC.updateAvailable, listener)
  },
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => {
    const listener = (_: unknown, progress: UpdateProgress): void => cb(progress)
    ipcRenderer.on(IPC.updateProgress, listener)
    return () => ipcRenderer.removeListener(IPC.updateProgress, listener)
  },
  /** Capture a bug report (version + recent packets + logs) and open the issue form. */
  reportBug: (): Promise<BugReportResult> => ipcRenderer.invoke(IPC.reportBug),
  /** Same capture-ring dump as `reportBug`, minus opening the issue form - just write the file and reveal it. */
  captureNow: (): Promise<BugReportResult> => ipcRenderer.invoke(IPC.captureNow),
  startChatProbe: (): Promise<ChatProbeStatus> => ipcRenderer.invoke(IPC.chatProbeStart),
  stopChatProbe: (): Promise<ChatProbeResult> => ipcRenderer.invoke(IPC.chatProbeStop),
  getChatProbeStatus: (): Promise<ChatProbeStatus> => ipcRenderer.invoke(IPC.getChatProbeStatus),
  setEditableFocused: (focused: boolean): void => {
    ipcRenderer.send(IPC.editableFocusChange, focused)
  }
}

export type { OverlayApi }

contextBridge.exposeInMainWorld('overlay', overlayApi)
