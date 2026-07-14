import type {
  BridgeStatus,
  BugReportResult,
  MainLogEntry,
  PacketEnvelope,
  SaveSettingsResult,
  SpritePack,
  UpdateInfo,
  UpdateProgress
} from './ipc'
import type { PanelInstance } from './panels'
import type { OverlaySettings } from './settings'

/**
 * The `window.overlay` contract the renderer talks to. Extracted as an
 * explicit interface (rather than `typeof overlayApi` inferred from the
 * preload's object literal) so a second implementation - the browser harness
 * shim (`renderer/src/harness/shim.ts`, PRD `docs/prd-agent-observability.md`
 * §5) - can implement it without importing `preload/index.ts`, which pulls in
 * `electron`'s `contextBridge`/`ipcRenderer` and doesn't bundle for a plain
 * browser page.
 */
export interface OverlayApi {
  onBridgeStatus: (cb: (status: BridgeStatus) => void) => () => void
  onPacketBatch: (cb: (packets: PacketEnvelope[]) => void) => () => void
  /** See the fan-out comment on the preload's packet-batch listener registry. */
  setPacketBatchSuspended: (suspended: boolean) => void
  onInteractiveChange: (cb: (interactive: boolean) => void) => () => void
  onAttachSuccess: (cb: () => void) => () => void
  onOverlayDetach: (cb: () => void) => () => void
  getBridgeStatus: () => Promise<BridgeStatus>
  getSettings: () => Promise<OverlaySettings>
  onSettingsChanged: (cb: (settings: OverlaySettings) => void) => () => void
  getAppVersion: () => Promise<string>
  saveSettings: (settings: OverlaySettings) => Promise<SaveSettingsResult>
  relaunch: () => Promise<void>
  getPanelLayout: () => Promise<PanelInstance[] | null>
  savePanelLayout: (panels: PanelInstance[]) => Promise<void>
  onMainLogEntry: (cb: (entry: MainLogEntry) => void) => () => void
  getBufferedMainLogs: () => Promise<MainLogEntry[]>
  getSpritePack: () => Promise<SpritePack>
  onSpritePack: (cb: (pack: SpritePack) => void) => () => void
  getUpdateStatus: () => Promise<UpdateInfo | null>
  checkForUpdate: () => Promise<UpdateInfo | null>
  downloadUpdate: () => Promise<void>
  onUpdateAvailable: (cb: (info: UpdateInfo) => void) => () => void
  onUpdateProgress: (cb: (progress: UpdateProgress) => void) => () => void
  /** Capture a bug report (version + recent packets + logs) and open the issue form. */
  reportBug: () => Promise<BugReportResult>
}
