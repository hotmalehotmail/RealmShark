import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

let configWindow: BrowserWindow | undefined

export function openConfigWindow(): void {
  if (configWindow) {
    configWindow.focus()
    return
  }

  configWindow = new BrowserWindow({
    width: 440,
    height: 360,
    resizable: false,
    title: 'RealmShark Overlay Settings',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    configWindow.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#config`)
  } else {
    configWindow.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'config' })
  }

  configWindow.on('closed', () => {
    configWindow = undefined
  })
}
