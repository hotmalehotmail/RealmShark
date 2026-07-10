export interface OverlaySettings {
  gameWindowTitle: string
  toggleHotkey: string
  /**
   * Milliseconds per frame when animating a textile (cloth) dye's woven pattern.
   * Higher = slower animation. RotMG's own rate isn't in our assets, so this is
   * tunable.
   */
  textileAnimMs: number
  /**
   * Animated-cloth SCROLL rate: output pattern-pixels/sec per unit of the dye's
   * own `speed` (from <AnimatedDye>). Higher = faster horizontal/vertical cloth
   * scroll. Tunable because RotMG's own rate isn't in our assets.
   */
  textileScrollSpeed: number
  /**
   * Animated-cloth ROTATE rate: radians/sec per unit of the dye's `speed`.
   * Higher = faster spin for rotating (vortex) cloths.
   */
  textileRotateSpeed: number
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  gameWindowTitle: 'RotMGExalt',
  toggleHotkey: 'Alt+Shift+R',
  textileAnimMs: 200,
  textileScrollSpeed: 1.5,
  textileRotateSpeed: 0.15
}
