/**
 * Anti-flash strategy for the alt-tab flash (temporary debug toggle).
 * - 'occlusion': keep Chromium painting the hidden window (disable native window
 *    occlusion + background throttling) so re-showing doesn't repaint-flash.
 * - 'nohide': don't hide the overlay on game-blur at all; sink it in z-order
 *    instead, so there's no re-show to animate.
 * - 'off': neither (baseline - will flash). Kept so we can confirm which fix works.
 * Once we know which one works, this toggle and the losing implementation go away.
 */
export type FlashFixMode = 'occlusion' | 'nohide' | 'off'

export interface OverlaySettings {
  gameWindowTitle: string
  toggleHotkey: string
  flashFix: FlashFixMode
}

export const DEFAULT_SETTINGS: OverlaySettings = {
  gameWindowTitle: 'RotMGExalt',
  toggleHotkey: 'Alt+Shift+R',
  flashFix: 'occlusion'
}
