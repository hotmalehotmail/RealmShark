import { app, BrowserWindow, globalShortcut, nativeImage } from 'electron'
import { join } from 'path'
import { electronApp, is } from '@electron-toolkit/utils'
import { OverlayController, OVERLAY_WINDOW_OPTS } from 'electron-overlay-window'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/ipc'
import { startBridgeClient } from './bridgeClient'
import { ensureBridgeRunning, stopBridge } from './bridgeSupervisor'
import { createTray, setTrayStatus } from './tray'

// electron-overlay-window relies on native window compositing; hardware
// acceleration can break overlay transparency. https://github.com/electron/electron/issues/25153
app.disableHardwareAcceleration()

const GAME_WINDOW_TITLE = 'Realm of the Mad God'
const TOGGLE_HOTKEY = 'Alt+Shift+R'

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

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    overlayWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    overlayWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  OverlayController.attachByTitle(overlayWindow, GAME_WINDOW_TITLE, {
    hasTitleBarOnMac: true
  })
}

/** Flips the overlay between click-through (game gets input) and interactive (overlay gets input). */
function toggleInteractive(): void {
  isInteractive = !isInteractive
  if (isInteractive) {
    OverlayController.activateOverlay()
  } else {
    OverlayController.focusTarget()
  }
  overlayWindow.webContents.send(IPC.interactiveChange, isInteractive)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.realmshark.overlay')

  createOverlayWindow()

  globalShortcut.register(TOGGLE_HOTKEY, toggleInteractive)

  createTray(nativeImage.createFromPath(icon), toggleInteractive)

  void ensureBridgeRunning()

  startBridgeClient({
    onStatus: (status) => {
      overlayWindow.webContents.send(IPC.bridgeStatus, status)
      setTrayStatus(status, toggleInteractive)
    },
    onBatch: (packets) => {
      overlayWindow.webContents.send(IPC.packetBatch, packets)
    }
  })
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  stopBridge()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
