/** Channel names shared between main and renderer over the Electron IPC bridge. */
export const IPC = {
  bridgeStatus: 'bridge-status',
  packetBatch: 'packet-batch',
  interactiveChange: 'interactive-change',
  getSettings: 'get-settings',
  saveSettings: 'save-settings',
  relaunch: 'relaunch-app'
} as const

/** Result of an IPC.saveSettings call. */
export interface SaveSettingsResult {
  /** Window-title changes can't be applied to a running attach; the app must restart. */
  needsRestart: boolean
  /** False if the requested hotkey was invalid or already claimed by another app; the previous hotkey stays active. */
  hotkeyRegistered: boolean
}

export type BridgeStatus = 'connecting' | 'connected' | 'disconnected'

/** One decoded packet as serialized by PacketSerializer on the Java side. */
export interface PacketEnvelope {
  type: string
  direction: 'CLIENT' | 'SERVER' | string
  time: number
  data: unknown
}
