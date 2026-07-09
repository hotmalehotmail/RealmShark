import { app, Menu, Tray } from 'electron'
import type { BridgeStatus } from '../shared/ipc'

const STATUS_LABEL: Record<BridgeStatus, string> = {
  connecting: 'Bridge: connecting…',
  connected: 'Bridge: connected',
  disconnected: 'Bridge: disconnected'
}

let tray: Tray | undefined
let status: BridgeStatus = 'connecting'

export function createTray(icon: Electron.NativeImage, onToggleOverlay: () => void): Tray {
  tray = new Tray(icon)
  tray.setToolTip('RealmShark Overlay')
  render(onToggleOverlay)
  return tray
}

export function setTrayStatus(next: BridgeStatus, onToggleOverlay: () => void): void {
  status = next
  render(onToggleOverlay)
}

function render(onToggleOverlay: () => void): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: STATUS_LABEL[status], enabled: false },
      { type: 'separator' },
      { label: 'Show/Hide Overlay', click: onToggleOverlay },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}
