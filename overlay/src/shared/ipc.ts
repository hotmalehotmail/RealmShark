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
  settingsChanged: 'settings-changed',
  getAppVersion: 'get-app-version',
  relaunch: 'relaunch-app',
  getPanelLayout: 'get-panel-layout',
  savePanelLayout: 'save-panel-layout',
  mainLogEntry: 'main-log-entry',
  getBufferedMainLogs: 'get-buffered-main-logs',
  getSpritePack: 'get-sprite-pack',
  spritePack: 'sprite-pack',
  getUpdateStatus: 'get-update-status',
  checkForUpdate: 'check-for-update',
  downloadUpdate: 'download-update',
  updateAvailable: 'update-available',
  updateProgress: 'update-progress'
} as const

/** A newer overlay release found on GitHub. */
export interface UpdateInfo {
  version: string
  tag: string
  notes: string
  downloadUrl: string
  size: number
}

/** Download progress while fetching an update installer. */
export interface UpdateProgress {
  received: number
  total: number
}

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

/**
 * The self-contained sprite pack: the RotMG atlas PNGs plus a flat
 * objectType -> atlas-rect table, so the renderer can crop any sprite locally.
 * `ready` is false when the bridge has no extracted game assets (no game
 * installed), in which case the overlay falls back to placeholder chips.
 */
export interface SpritePack {
  ready: boolean
  /** Version key; changes when the bridge re-extracts assets (a game update). */
  version?: string
  /** atlasId ("1".."4") -> data: URL of the atlas PNG. */
  atlases?: Record<string, string>
  /** objectType -> [atlasId, x, y, w, h] within that atlas. */
  table?: Record<string, [number, number, number, number, number]>
  /**
   * objectType -> [maskAtlasId(=3), x, y, w, h] of the dye mask (marks the
   * clothing/accessory regions), for objectTypes that have one. Used to
   * composite clothing/accessory dyes onto a character sprite.
   */
  maskTable?: Record<string, [number, number, number, number, number]>
  /**
   * dyeId -> the cloth a dye applies (its color/pattern, parsed from the dye
   * object's XML - the dye's own sprite is only a generic icon). Encoding:
   *   solid:   [1, r, g, b]
   *   textile: [10, atlasId, x, y, w, h]  (the pattern's rect to tile)
   */
  dyeTable?: Record<string, number[]>
}
