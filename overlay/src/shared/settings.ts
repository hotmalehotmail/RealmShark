export interface OverlaySettings {
  gameWindowTitle: string
  toggleHotkey: string
  /**
   * Milliseconds per frame when animating a textile (cloth) dye's woven pattern.
   * Higher = slower animation. RotMG's own rate isn't in our assets, so this is
   * tunable.
   */
  textileAnimMs: number
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  gameWindowTitle: 'RotMGExalt',
  toggleHotkey: 'Alt+Shift+R',
  textileAnimMs: 200
}
