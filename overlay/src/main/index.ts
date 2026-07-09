import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { OverlayController, OVERLAY_WINDOW_OPTS } from 'electron-overlay-window'
import icon from '../../resources/icon.png?asset'
import { IPC, type BridgeStatus, type SaveSettingsResult } from '../shared/ipc'
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
      overlayWindow.webContents.send(IPC.attachSuccess)
    })
    // The target window (the game) was closed - distinct from 'blur', which
    // just means it lost focus. This is the signal to wipe session-scoped UI
    // state like the DPS tracker, not a mere focus change.
    OverlayController.events.on('detach', () => {
      overlayWindow.webContents.send(IPC.overlayDetach)
    })
  } else {
    console.log(
      '[overlay] platform has no window-attach support - showing a standalone window for local UI testing'
    )
    overlayWindow.setIgnoreMouseEvents(true)
    overlayWindow.show()
    setTimeout(() => overlayWindow.webContents.send(IPC.attachSuccess), 1000)
  }
}

/** Flips the overlay between click-through (game gets input) and interactive (overlay gets input). */
function toggleInteractive(): void {
  isInteractive = !isInteractive
  if (supportsAttach) {
    if (isInteractive) {
      OverlayController.activateOverlay()
    } else {
      OverlayController.focusTarget()
    }
  } else {
    overlayWindow.setIgnoreMouseEvents(!isInteractive)
    if (isInteractive) overlayWindow.focus()
  }
  // A focusable window can end up holding OS keyboard focus (e.g. right after
  // activateOverlay()'s own .focus() call above) even once mouse events are
  // passed through again - without this, keystrokes meant for the game can
  // keep going to the (invisible) overlay after toggling back to click-through.
  overlayWindow.setFocusable(isInteractive)
  overlayWindow.webContents.send(IPC.interactiveChange, isInteractive)
}

function registerHotkey(accelerator: string): boolean {
  const ok = globalShortcut.register(accelerator, toggleInteractive)
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
    },
    onConnected: requestSpritePack,
    onSpritePack: onSpritePackMessage
  })

  ipcMain.handle(IPC.getBridgeStatus, (): BridgeStatus => currentBridgeStatus)

  ipcMain.handle(IPC.getBufferedMainLogs, () => getBufferedMainLogs())

  ipcMain.handle(IPC.getSettings, (): OverlaySettings => settings)

  ipcMain.handle(IPC.getAppVersion, (): string => app.getVersion())

  ipcMain.handle(IPC.getSpritePack, () => getSpritePack())

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
      toggleHotkey: hotkeyRegistered ? next.toggleHotkey : settings.toggleHotkey
    }
    persistSettings(settings)

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
