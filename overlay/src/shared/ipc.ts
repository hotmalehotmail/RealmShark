/** Channel names shared between main and renderer over the Electron IPC bridge. */
export const IPC = {
  bridgeStatus: 'bridge-status',
  getBridgeStatus: 'get-bridge-status',
  packetBatch: 'packet-batch',
  interactiveChange: 'interactive-change',
  attachSuccess: 'attach-success',
  overlayDetach: 'overlay-detach',
  getSettings: 'get-settings',
  saveSettings: 'save-settings',
  relaunch: 'relaunch-app',
  getPanelLayout: 'get-panel-layout',
  savePanelLayout: 'save-panel-layout',
  mainLogEntry: 'main-log-entry',
  getBufferedMainLogs: 'get-buffered-main-logs'
} as const

/** Result of an IPC.saveSettings call. */
export interface SaveSettingsResult {
  /** Window-title changes can't be applied to a running attach; the app must restart. */
  needsRestart: boolean
  /** False if the requested hotkey was invalid or already claimed by another app; the previous hotkey stays active. */
  hotkeyRegistered: boolean
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

export type LogLevel = 'log' | 'info' | 'warn' | 'error'

/** A single main-process console.* call, forwarded to the renderer's console panel. */
export interface MainLogEntry {
  level: LogLevel
  time: number
  message: string
}

/** One decoded packet as serialized by PacketSerializer on the Java side. */
export interface PacketEnvelope {
  type: string
  direction: 'CLIENT' | 'SERVER' | string
  time: number
  data: unknown
}
