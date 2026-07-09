export interface OverlaySettings {
  gameWindowTitle: string
  toggleHotkey: string
  /**
   * Sub-pixel subdivision used when tiling a textile (cloth) dye's woven pattern
   * onto a character. Higher = finer/smaller weave. ~10 matches the in-game look.
   */
  textileResolution: number
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  gameWindowTitle: 'RotMGExalt',
  toggleHotkey: 'Alt+Shift+R',
  textileResolution: 10
}
