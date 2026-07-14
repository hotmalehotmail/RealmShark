import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, shell } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import { gzipSync } from 'zlib'
import { electronApp, is } from '@electron-toolkit/utils'
import { OverlayController, OVERLAY_WINDOW_OPTS } from 'electron-overlay-window'
import icon from '../../resources/icon.png?asset'
import {
  IPC,
  type BridgeStatus,
  type BugReportResult,
  type PacketEnvelope,
  type SaveSettingsResult
} from '../shared/ipc'
import { CaptureRing } from '../shared/capture'
import type { PanelInstance } from '../shared/panels'
import type { OverlaySettings } from '../shared/settings'
import { startBridgeClient, stopBridgeClient } from './bridgeClient'
import { ensureBridgeRunning, stopBridge } from './bridgeSupervisor'
import { openConfigWindow } from './configWindow'
import { getBufferedMainLogs, installMainConsoleCapture, setMainLogSink } from './consoleCapture'
import { loadPanelLayout, persistPanelLayout } from './panelLayout'
import { getSpritePack, initSpritePack, onSpritePackMessage, requestSpritePack } from './spritePack'
import { loadSettings, persistSettings } from './settings'
import { createTray, setTrayStatus } from './tray'
import {
  checkForUpdate,
  downloadInstaller,
  getCachedUpdate,
  installAndRestart,
  startUpdatePolling
} from './updater'

// Installed before anything else logs, so bridge-supervisor/bridge-client
// output (only otherwise visible in a terminal) is captured from process
// start and can backfill the renderer's console panel once it mounts.
installMainConsoleCapture()

// electron-overlay-window relies on native window compositing; hardware
// acceleration can break overlay transparency. https://github.com/electron/electron/issues/25153
app.disableHardwareAcceleration()

// Neither the overlay HUD nor the settings window needs the default
// File/Edit/View/Window/Help menu bar - drop it app-wide.
Menu.setApplicationMenu(null)

// Only ever allow one overlay (and one supervised bridge). A losing second
// launch must quit and do NOTHING else - in particular it must not run the
// bridge supervisor, whose reaper would force-kill the FIRST (still-running)
// instance's healthy bridge, leaving it bridgeless with no respawn. A genuine
// orphan (from a crashed instance that released the lock) is instead reaped by
// the launch that WINS the lock. Startup below is gated on gotSingleInstanceLock.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

// electron-overlay-window can only attach to a real target window on Windows
// or Linux (X11). Everywhere else (macOS during development, mainly) fall
// back to a plain visible window and a simulated attach, so the UI can be
// built/tested without the game - see createOverlayWindow() below.
const supportsAttach = process.platform === 'win32' || process.platform === 'linux'

let settings = loadSettings()
let currentHotkey = settings.toggleHotkey
let currentBridgeStatus: BridgeStatus = 'connecting'

let overlayWindow: BrowserWindow
let isInteractive = false
// Whether the attached game window currently has OS focus (from
// electron-overlay-window's focus/blur events). Used to ignore the global
// toggle hotkey when the user has alt-tabbed away from the game.
let gameHasFocus = false

function createOverlayWindow(): void {
  overlayWindow = new BrowserWindow({
    width: 900,
    height: 670,
    ...OVERLAY_WINDOW_OPTS,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // Starts non-interactive (isInteractive = false) - make sure the window
  // can't hold OS keyboard focus from the outset, not just after the first
  // toggle. See the setFocusable() call in toggleInteractive() for why.
  overlayWindow.setFocusable(false)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  if (supportsAttach) {
    // electron-overlay-window matches this with an exact strcmp, not a substring
    // or regex - must match the live window title byte-for-byte, including case.
    // Also: the library can only be attached once per process, so changing this
    // requires a restart (see IPC.saveSettings handler below).
    OverlayController.attachByTitle(overlayWindow, settings.gameWindowTitle, {
      hasTitleBarOnMac: true
    })
    OverlayController.events.on('attach', () => {
      gameHasFocus = true
      overlayWindow.webContents.send(IPC.attachSuccess)
    })
    OverlayController.events.on('focus', () => {
      gameHasFocus = true
    })
    OverlayController.events.on('blur', () => {
      gameHasFocus = false
    })
    // The target window (the game) was closed - distinct from 'blur', which
    // just means it lost focus. This is the signal to wipe session-scoped UI
    // state like the DPS tracker, not a mere focus change.
    OverlayController.events.on('detach', () => {
      gameHasFocus = false
      overlayWindow.webContents.send(IPC.overlayDetach)
    })

    installNoHideStrategy()
  } else {
    console.log(
      '[overlay] platform has no window-attach support - showing a standalone window for local UI testing'
    )
    overlayWindow.setIgnoreMouseEvents(true)
    overlayWindow.show()
    setTimeout(() => overlayWindow.webContents.send(IPC.attachSuccess), 1000)
  }
}

/**
 * Stop the alt-tab "flash": the library hides the overlay on game-blur and
 * re-shows it on focus, and that re-show is what flashed. Instead of hiding,
 * SINK the overlay (drop always-on-top + go click-through) so it falls behind a
 * covering window along with the game, then re-raise it on game-focus - no
 * hide/show, nothing to animate. The real hide() is preserved for detach (game
 * actually closed), where the overlay should truly disappear.
 */
function installNoHideStrategy(): void {
  const realHide = overlayWindow.hide.bind(overlayWindow)
  let detaching = false

  // Run before the library's own detach handler (which calls hide()), so a
  // detach does a real hide rather than a sink.
  OverlayController.events.prependListener('detach', () => {
    detaching = true
  })

  // The library calls hide() on game-blur; sink instead (unless detaching).
  overlayWindow.hide = (): void => {
    if (detaching) {
      realHide()
      return
    }
    overlayWindow.setAlwaysOnTop(false)
    overlayWindow.setIgnoreMouseEvents(true)
  }

  // On game-focus the library only re-raises a hidden window; ours stayed
  // visible, so re-raise it back on top here.
  OverlayController.events.on('focus', () => {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver')
  })
}

/** Flips the overlay between click-through (game gets input) and interactive (overlay gets input). */
function toggleInteractive(): void {
  isInteractive = !isInteractive
  if (isInteractive) {
    // Become focusable first, then take focus.
    overlayWindow.setFocusable(true)
    if (supportsAttach) {
      OverlayController.activateOverlay()
    } else {
      overlayWindow.setIgnoreMouseEvents(false)
      overlayWindow.focus()
    }
  } else {
    // Hand input back to the game. Drop focusability and actively release our
    // own focus (blur) BEFORE focusing the target, so the OS doesn't bounce
    // focus back to the overlay - otherwise the game stays unfocused and the
    // user has to click it to regain keyboard control.
    overlayWindow.setFocusable(false)
    overlayWindow.blur()
    if (supportsAttach) {
      OverlayController.focusTarget()
    } else {
      overlayWindow.setIgnoreMouseEvents(true)
    }
  }
  overlayWindow.webContents.send(IPC.interactiveChange, isInteractive)
}

/**
 * Global-hotkey handler. Unlike the tray toggle (which the user can only reach
 * by leaving the game), the hotkey must NOT pop the overlay up when they've
 * alt-tabbed to another app - only when the game has focus, or when the overlay
 * is already interactive (so they can always toggle it back off).
 */
function onToggleHotkey(): void {
  if (supportsAttach && !isInteractive && !gameHasFocus) return
  toggleInteractive()
}

function registerHotkey(accelerator: string): boolean {
  const ok = globalShortcut.register(accelerator, onToggleHotkey)
  if (ok) currentHotkey = accelerator
  return ok
}

app.on('second-instance', () => {
  overlayWindow?.showInactive()
})

app.whenReady().then(() => {
  // Losing second instance: quit() was already called above; do no startup so
  // we never touch the first instance's bridge.
  if (!gotSingleInstanceLock) return

  electronApp.setAppUserModelId('com.realmshark.overlay')

  createOverlayWindow()

  setMainLogSink((entry) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.mainLogEntry, entry)
    }
  })

  registerHotkey(settings.toggleHotkey)

  createTray(nativeImage.createFromPath(icon), {
    onToggleOverlay: toggleInteractive,
    onOpenSettings: openConfigWindow
  })

  initSpritePack((pack) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.spritePack, pack)
    }
  })

  void ensureBridgeRunning(!supportsAttach)

  // Rolling window of recent packets kept for the "Report bug" capture, so a
  // bug found against the live game ships with a replayable trace. Filtered
  // through CAPTURE_ALLOWED_TYPES (src/shared/capture.ts, default-deny) so a
  // new or unexpected packet type can't leak into the capture attached to a
  // PUBLIC issue - this drops chat (TextPacket, incl. DMs), account lists, and
  // connection/auth packets (Hello/Reconnect). Credential FIELDS are
  // separately stripped bridge-side (PacketSerializer); this drops the whole
  // sensitive packet TYPES. See docs/overlay-testing.md for the ring's
  // capacity/quota model and the replay tests that consume its output shape.
  const captureRing = new CaptureRing()

  startBridgeClient({
    onStatus: (status) => {
      currentBridgeStatus = status
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(IPC.bridgeStatus, status)
      }
      setTrayStatus(status)
    },
    onBatch: (packets) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(IPC.packetBatch, packets)
      }
      // The live overlay above still receives the full batch; only the
      // bug-report trace is filtered and ring-bounded.
      for (const p of packets as PacketEnvelope[]) {
        captureRing.push(p)
      }
    },
    onConnected: requestSpritePack,
    onSpritePack: onSpritePackMessage
  })

  ipcMain.handle(IPC.getBridgeStatus, (): BridgeStatus => currentBridgeStatus)

  ipcMain.handle(IPC.getBufferedMainLogs, () => getBufferedMainLogs())

  ipcMain.handle(IPC.getSettings, (): OverlaySettings => settings)

  ipcMain.handle(IPC.getAppVersion, (): string => app.getVersion())

  ipcMain.handle(IPC.getSpritePack, () => getSpritePack())

  // Report bug: dump version + recent packets + main logs to a JSON file, reveal
  // it so the user can drag it into the issue's repro field, and open the
  // prefilled bug-report form. The capture is the linchpin — it lets a headless
  // fix agent reproduce a live-game bug via FakePacketSource.
  ipcMain.handle(IPC.reportBug, async (): Promise<BugReportResult> => {
    const capture = {
      version: app.getVersion(),
      platform: process.platform,
      arch: process.arch,
      capturedAt: new Date().toISOString(),
      bridgeStatus: currentBridgeStatus,
      gameWindowTitle: settings.gameWindowTitle,
      recentPackets: captureRing.snapshot(),
      mainLogs: getBufferedMainLogs()
    }
    const file = join(app.getPath('temp'), `realmshark-bug-${Date.now()}.json.gz`)
    await writeFile(file, gzipSync(JSON.stringify(capture)))
    shell.showItemInFolder(file)
    const version = encodeURIComponent(app.getVersion())
    await shell.openExternal(
      `https://github.com/white-bag/thessal/issues/new?template=bug_report.yml&version=${version}`
    )
    return { file }
  })

  startUpdatePolling((info) => {
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.updateAvailable, info)
    }
  })

  ipcMain.handle(IPC.getUpdateStatus, () => getCachedUpdate())

  ipcMain.handle(IPC.checkForUpdate, () => checkForUpdate())

  ipcMain.handle(IPC.downloadUpdate, async () => {
    const info = getCachedUpdate() ?? (await checkForUpdate())
    if (!info) return
    const exe = await downloadInstaller(info, (received, total) => {
      if (overlayWindow && !overlayWindow.isDestroyed()) {
        overlayWindow.webContents.send(IPC.updateProgress, { received, total })
      }
    })
    installAndRestart(exe)
  })

  ipcMain.handle(IPC.saveSettings, (_event, next: OverlaySettings): SaveSettingsResult => {
    const titleChanged = next.gameWindowTitle !== settings.gameWindowTitle
    const hotkeyChanged = next.toggleHotkey !== currentHotkey

    let hotkeyRegistered = true
    if (hotkeyChanged) {
      globalShortcut.unregister(currentHotkey)
      hotkeyRegistered = registerHotkey(next.toggleHotkey)
      if (!hotkeyRegistered) {
        // Requested accelerator was invalid or already claimed by another app - keep the old one working.
        registerHotkey(settings.toggleHotkey)
      }
    }

    settings = {
      ...next,
      toggleHotkey: hotkeyRegistered ? next.toggleHotkey : settings.toggleHotkey,
      // Clamp to a sane range so a bad value can't stall or thrash the render loop.
      textileAnimMs: Math.min(2000, Math.max(50, Math.round(next.textileAnimMs))) || 200,
      // Cloth scroll/rotate rates are floats; NaN/missing falls back via `|| default`.
      textileScrollSpeed: Math.min(20, Math.max(0.1, next.textileScrollSpeed)) || 1.5,
      textileRotateSpeed: Math.min(3, Math.max(0.01, next.textileRotateSpeed)) || 0.15
    }
    persistSettings(settings)

    // Push live so the overlay renderer picks up e.g. the textile animation
    // rate without a restart.
    if (overlayWindow && !overlayWindow.isDestroyed()) {
      overlayWindow.webContents.send(IPC.settingsChanged, settings)
    }

    return { needsRestart: titleChanged, hotkeyRegistered }
  })

  ipcMain.handle(IPC.relaunch, () => {
    app.relaunch()
    app.exit(0)
  })

  ipcMain.handle(IPC.getPanelLayout, (): PanelInstance[] | null => loadPanelLayout())

  ipcMain.handle(IPC.savePanelLayout, (_event, panels: PanelInstance[]) => {
    persistPanelLayout(panels)
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Sever the bridge client BEFORE killing the bridge: stopBridge() drops the
  // socket, whose close event would otherwise fire onStatus back into the
  // already-destroyed overlay window.
  stopBridgeClient()
  // Never stop the bridge from a losing second instance - it isn't ours; it
  // belongs to the still-running first instance.
  if (gotSingleInstanceLock) stopBridge()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
