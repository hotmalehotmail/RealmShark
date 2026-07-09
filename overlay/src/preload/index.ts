import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BridgeStatus,
  type MainLogEntry,
  type PacketEnvelope,
  type SaveSettingsResult,
  type SpritePack,
  type UpdateInfo,
  type UpdateProgress
} from '../shared/ipc'
import type { PanelInstance } from '../shared/panels'
import type { OverlaySettings } from '../shared/settings'

const overlayApi = {
  onBridgeStatus: (cb: (status: BridgeStatus) => void) => {
    const listener = (_: unknown, status: BridgeStatus): void => cb(status)
    ipcRenderer.on(IPC.bridgeStatus, listener)
    return () => ipcRenderer.removeListener(IPC.bridgeStatus, listener)
  },
  onPacketBatch: (cb: (packets: PacketEnvelope[]) => void) => {
    const listener = (_: unknown, packets: PacketEnvelope[]): void => cb(packets)
    ipcRenderer.on(IPC.packetBatch, listener)
    return () => ipcRenderer.removeListener(IPC.packetBatch, listener)
  },
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
  }
}

export type OverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('overlay', overlayApi)
