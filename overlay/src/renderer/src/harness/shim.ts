import type {
  BridgeStatus,
  BugReportResult,
  MainLogEntry,
  PacketEnvelope,
  SaveSettingsResult,
  SpritePack,
  UpdateInfo,
  UpdateProgress
} from '../../../shared/ipc'
import type { OverlayApi } from '../../../shared/overlayApi'
import type { PanelInstance } from '../../../shared/panels'
import { DEFAULT_SETTINGS, type OverlaySettings } from '../../../shared/settings'
import { startFixtureSource } from './fixtureSource'
import { startWsSource } from './wsSource'

const SETTINGS_KEY = 'realmshark-harness:settings'
const PANEL_LAYOUT_KEY = 'realmshark-harness:panelLayout'
/** Deferred so App/PanelCanvas's mount-time `useEffect` subscribers are registered first (see installHarness doc comment). */
const ATTACH_DELAY_MS = 50

function readJson<T>(key: string): T | null {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // localStorage unavailable/full - the harness has nothing durable to fall back to; settings just reset next load.
  }
}

/** A tiny pub/sub of listener sets, one per OverlayApi `onX` channel. */
function channel<T>(): { emit: (value: T) => void; on: (cb: (value: T) => void) => () => void } {
  const listeners = new Set<(value: T) => void>()
  return {
    emit: (value: T): void => {
      for (const cb of listeners) cb(value)
    },
    on: (cb: (value: T) => void): (() => void) => {
      listeners.add(cb)
      return () => listeners.delete(cb)
    }
  }
}

/**
 * A handful of representative log lines so the Console panel (fed only by
 * real `console.*` calls, not the packet stream) isn't an empty "no logs
 * yet" in every harness screenshot - `main.tsx`'s `installConsoleCapture()`
 * runs before this, so these route into the same buffer a real session's
 * `[bridge-client]`/`[dps-engine]`-prefixed main-process logs would.
 */
function logHarnessBanner(): void {
  console.log('[harness] renderer harness active - overlay/src/renderer/src/harness/shim.ts')
  console.info('[bridge-client] connected to ws://127.0.0.1:47474')
  console.warn('[harness] sprite pack is a small synthetic fixture, not real game assets')
}

/**
 * Installs a browser-only implementation of `OverlayApi` (PRD
 * `docs/prd-agent-observability.md` §5) on `window.overlay`, so the renderer
 * can run in plain headless Chromium with no Electron main process behind it.
 * Only called by `main.tsx` when `window.overlay` is undefined AND
 * `import.meta.env.VITE_HARNESS` is set (see `docs/overlay-harness.md`) -
 * production builds never reach this module (dynamic-import + dead-code
 * elimination keeps it out of that bundle entirely).
 *
 * Settings and panel layout persist to `localStorage` (defaults on first
 * load, same shape the real main-process IPC handlers return).
 * `getBridgeStatus`/`onAttachSuccess`/`onInteractiveChange` fire the one-shot
 * "attached and interactive" sequence real startup does, deferred by
 * `ATTACH_DELAY_MS` so `App`'s effects have already subscribed - mirrors the
 * non-`supportsAttach` fallback's own `setTimeout` in `main/index.ts`.
 * `onPacketBatch`/`onSpritePack` are wired to whichever data source the URL
 * selects: `?fixture=<name>` plays back a committed fixture
 * (`harness/fixtureSource.ts`); otherwise a live WebSocket client connects to
 * the real bridge (`harness/wsSource.ts`), same as `gradle runBridge
 * -Pargs="--fake"`.
 */
export function installHarness(): void {
  const packetBatch = channel<PacketEnvelope[]>()
  const spritePack = channel<SpritePack>()
  const bridgeStatus = channel<BridgeStatus>()
  const interactiveChange = channel<boolean>()
  const attachSuccess = channel<void>()
  const overlayDetach = channel<void>()
  const settingsChanged = channel<OverlaySettings>()
  const mainLogEntry = channel<MainLogEntry>()
  const updateAvailable = channel<UpdateInfo>()
  const updateProgress = channel<UpdateProgress>()

  let currentStatus: BridgeStatus = 'connected'
  let settings = readJson<OverlaySettings>(SETTINGS_KEY) ?? { ...DEFAULT_SETTINGS }
  let packetBatchSuspended = false
  let suspendedBatches: PacketEnvelope[][] = []

  const api: OverlayApi = {
    onBridgeStatus: bridgeStatus.on,
    onPacketBatch: packetBatch.on,
    setPacketBatchSuspended: (suspended) => {
      packetBatchSuspended = suspended
      if (!suspended && suspendedBatches.length > 0) {
        const merged = suspendedBatches.flat()
        suspendedBatches = []
        packetBatch.emit(merged)
      }
    },
    onInteractiveChange: interactiveChange.on,
    onAttachSuccess: attachSuccess.on,
    onOverlayDetach: overlayDetach.on,
    getBridgeStatus: () => Promise.resolve(currentStatus),
    getSettings: () => Promise.resolve(settings),
    onSettingsChanged: settingsChanged.on,
    getAppVersion: () => Promise.resolve('harness'),
    saveSettings: (next): Promise<SaveSettingsResult> => {
      settings = next
      writeJson(SETTINGS_KEY, settings)
      settingsChanged.emit(settings)
      return Promise.resolve({ needsRestart: false, hotkeyRegistered: true })
    },
    relaunch: () => Promise.resolve(),
    getPanelLayout: () => Promise.resolve(readJson<PanelInstance[]>(PANEL_LAYOUT_KEY)),
    savePanelLayout: (panels) => {
      writeJson(PANEL_LAYOUT_KEY, panels)
      return Promise.resolve()
    },
    onMainLogEntry: mainLogEntry.on,
    getBufferedMainLogs: () => Promise.resolve([]),
    getSpritePack: () => Promise.resolve({ ready: false }),
    onSpritePack: spritePack.on,
    getUpdateStatus: () => Promise.resolve(null),
    checkForUpdate: () => Promise.resolve(null),
    downloadUpdate: () => Promise.resolve(),
    onUpdateAvailable: updateAvailable.on,
    onUpdateProgress: updateProgress.on,
    reportBug: (): Promise<BugReportResult> => Promise.resolve({ file: '' }),
    captureNow: (): Promise<BugReportResult> => Promise.resolve({ file: '' }),
    // No main process to buffer/write anything - the probe reports inactive
    // and captures nothing in the harness.
    startChatProbe: () => Promise.resolve({ active: false, captured: 0 }),
    stopChatProbe: () => Promise.resolve({ file: null, captured: 0 }),
    getChatProbeStatus: () => Promise.resolve({ active: false, captured: 0 }),
    // No main process to gate here - the harness has no global Esc dismiss.
    setEditableFocused: (): void => {}
  }

  window.overlay = api
  logHarnessBanner()

  setTimeout(() => {
    currentStatus = 'connected'
    bridgeStatus.emit(currentStatus)
    attachSuccess.emit()
    interactiveChange.emit(true)
  }, ATTACH_DELAY_MS)

  const sink = {
    onBatch: (packets: PacketEnvelope[]): void => {
      if (packetBatchSuspended) {
        suspendedBatches.push(packets)
        return
      }
      packetBatch.emit(packets)
    },
    onSpritePack: (pack: SpritePack): void => spritePack.emit(pack),
    onStatus: (status: BridgeStatus): void => {
      currentStatus = status
      bridgeStatus.emit(status)
    }
  }

  const params = new URLSearchParams(window.location.search)
  const fixture = params.get('fixture')
  if (fixture) {
    startFixtureSource(fixture, sink, { paced: params.has('paced') })
  } else {
    startWsSource(sink)
  }
}
