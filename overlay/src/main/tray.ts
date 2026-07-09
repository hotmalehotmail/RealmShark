import { app, Menu, Tray } from 'electron'
import type { BridgeStatus } from '../shared/ipc'

const STATUS_LABEL: Record<BridgeStatus, string> = {
  connecting: 'Bridge: connecting…',
  connected: 'Bridge: connected',
  disconnected: 'Bridge: disconnected'
}

export interface TrayCallbacks {
  onToggleOverlay: () => void
  onOpenSettings: () => void
}

let tray: Tray | undefined
let status: BridgeStatus = 'connecting'
let callbacks: TrayCallbacks

export function createTray(icon: Electron.NativeImage, cbs: TrayCallbacks): Tray {
  callbacks = cbs
  tray = new Tray(icon)
  tray.setToolTip('RealmShark Overlay')
  render()
  return tray
}

export function setTrayStatus(next: BridgeStatus): void {
  status = next
  render()
}

function render(): void {
  if (!tray) return
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: STATUS_LABEL[status], enabled: false },
      { type: 'separator' },
      { label: 'Show/Hide Overlay', click: callbacks.onToggleOverlay },
      { label: 'Settings…', click: callbacks.onOpenSettings },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
}
