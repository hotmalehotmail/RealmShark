import type { ChatProbeResult, ChatProbeStatus } from './chatProbe'
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
  /** Same capture-ring dump as `reportBug`, minus opening the issue form - just write the file and reveal it. */
  captureNow: () => Promise<BugReportResult>
  /** Arm the chat probe: a local-only diagnostic retaining the chat/party envelope types bug captures deliberately drop (`shared/chatProbe.ts`). */
  startChatProbe: () => Promise<ChatProbeStatus>
  /** Disarm the probe; writes what it captured to `userData/diagnostics/*.ndjson` and reveals the file (no file when nothing captured). */
  stopChatProbe: () => Promise<ChatProbeResult>
  /** Current armed state + live captured count (polled by the Status panel while armed). */
  getChatProbeStatus: () => Promise<ChatProbeStatus>
  /**
   * Ask main to re-send its cached metadata-table envelopes through the
   * normal packet-batch path (issue #245 - for consumers that subscribed
   * after the bridge's one-shot edge-triggered delivery). Idempotent for
   * everyone else: same-metaVersion envelopes are skipped on arrival.
   */
  replayMetadata: () => Promise<void>
  /**
   * Tell the main process whether a text-editable element (input/textarea/
   * contenteditable) currently has focus in the renderer, so the global Esc
   * dismiss can skip while a panel's own Esc affordance (e.g. Console's
   * search-clear) should handle it instead.
   */
  setEditableFocused: (focused: boolean) => void
}
