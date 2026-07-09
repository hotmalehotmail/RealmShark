import type { BrowserWindow } from 'electron'

/**
 * Disable Windows DWM show/hide transition animations for a window.
 *
 * electron-overlay-window hides the overlay when the game loses focus and
 * re-shows it when the game regains focus. Windows animates that re-show (the
 * same restore/open animation as un-minimizing a window), so alt-tabbing back
 * into the game makes the panels "flash into place". Setting
 * DWMWA_TRANSITIONS_FORCEDISABLED tells the compositor never to animate this
 * window's show/hide, removing the flash while keeping the hide/show behaviour
 * (and the pinned-panel occlusion that depends on it).
 *
 * Windows-only and best-effort: a no-op on other platforms, and any failure
 * (missing/loadable native module, DWM unavailable) is swallowed so the overlay
 * still works - just with the animation.
 */
export function disableWindowAnimations(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  try {
    // Lazy require, guarded: only Windows loads the native FFI module, and any
    // failure is caught below so a packaging/loader issue can't break startup.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const koffi = require('koffi')
    const dwmapi = koffi.load('dwmapi.dll')
    const DwmSetWindowAttribute = dwmapi.func(
      'int __stdcall DwmSetWindowAttribute(void *hwnd, uint dwAttribute, void *pvAttribute, uint cbAttribute)'
    )

    const DWMWA_TRANSITIONS_FORCEDISABLED = 3
    const handle = win.getNativeWindowHandle()
    // getNativeWindowHandle() returns a Buffer *containing* the HWND pointer;
    // read the raw address to pass as the pointer value (koffi accepts BigInt).
    const hwnd = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0))
    const value = Buffer.alloc(4)
    value.writeInt32LE(1, 0) // TRUE

    const hr = DwmSetWindowAttribute(hwnd, DWMWA_TRANSITIONS_FORCEDISABLED, value, 4)
    console.log(`[overlay] disabled window transition animations (hr=${hr})`)
  } catch (e) {
    console.error('[overlay] could not disable window animations:', (e as Error).message)
  }
}
