import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type BridgeStatus,
  type MainLogEntry,
  type PacketEnvelope,
  type SaveSettingsResult
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
  getBufferedMainLogs: (): Promise<MainLogEntry[]> => ipcRenderer.invoke(IPC.getBufferedMainLogs)
}

export type OverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('overlay', overlayApi)
