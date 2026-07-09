/**
 * Panel position is a percentage of the overlay window, anchored at a
 * specific point of the panel (currently always its top-left corner - "pos"
 * is kept as a field so a future multi-corner drag affordance, like
 * Exiled-Exchange-2's 9-point anchor system, is a rendering change only, not
 * a data-model change). Percentage-based position stays visually correct if
 * the overlay window resizes (the game window changed size), with no
 * explicit reclamping needed.
 */
export type AnchorPoint = 'tl'

export interface Anchor {
  pos: AnchorPoint
  x: number // 0-100, percent of window width
  y: number // 0-100, percent of window height
}

export type PanelSize = 'sm' | 'md' | 'lg'

export interface PanelInstance {
  id: string
  type: string
  anchor: Anchor
  size: PanelSize
  zIndex: number
  /**
   * A pinned panel stays visible even when the overlay is in invisible
   * (click-through) mode - useful for keeping a DPS meter on screen while
   * playing. Optional so layouts saved before pinning existed stay valid
   * (undefined = not pinned). Pinned panels are still non-interactive and
   * non-focusable while the overlay is hidden; they're display-only.
   */
  pinned?: boolean
}
