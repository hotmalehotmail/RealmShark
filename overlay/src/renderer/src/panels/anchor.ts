import type { CSSProperties } from 'react'
import type { Anchor } from '../../../shared/panels'

export interface SizePx {
  width: number
  height: number
}

/**
 * Position + size CSS for a panel anchored at its top-left corner. The
 * preset size is a target, capped by how much room is actually left before
 * the panel would run past the window's right/bottom edge - this only
 * matters if the anchor point sits close to an edge, but it's what keeps a
 * panel from getting clipped or pushed off-screen if the overlay window
 * (i.e. the game window) shrinks after the layout was saved.
 */
export function panelStyle(
  anchor: Anchor,
  targetSizePx: SizePx,
  canvasSizePx: SizePx
): CSSProperties {
  const maxWidthPx = ((100 - anchor.x) / 100) * canvasSizePx.width
  const maxHeightPx = ((100 - anchor.y) / 100) * canvasSizePx.height

  return {
    position: 'absolute',
    top: `${anchor.y}%`,
    left: `${anchor.x}%`,
    width: Math.max(0, Math.min(targetSizePx.width, maxWidthPx)),
    height: Math.max(0, Math.min(targetSizePx.height, maxHeightPx))
  }
}

/** Converts a pointer position (window-relative) into a clamped 0-100% anchor coordinate. */
export function anchorFromPointer(
  clientX: number,
  clientY: number,
  canvasSizePx: SizePx
): { x: number; y: number } {
  const x = Math.min(Math.max(clientX / canvasSizePx.width, 0), 1) * 100
  const y = Math.min(Math.max(clientY / canvasSizePx.height, 0), 1) * 100
  return { x, y }
}
