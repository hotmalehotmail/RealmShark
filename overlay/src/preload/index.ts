import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type BridgeStatus, type PacketEnvelope } from '../shared/ipc'

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
  }
}

export type OverlayApi = typeof overlayApi

contextBridge.exposeInMainWorld('overlay', overlayApi)
