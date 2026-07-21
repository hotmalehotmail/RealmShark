import type { CSSProperties } from 'react'
import type { Anchor } from '../../../shared/panels'

export interface SizePx {
  width: number
  height: number
}

/**
 * Sub-pixel slack in `panelStyle`'s edge cap. `anchorFromPointer` bounds a
 * dragged anchor to exactly the point where the preset size fits, but that
 * bound is a percentage and the cap re-derives pixels from it - a round trip
 * that lands ~1e-13px short in floating point. Without this slack a panel
 * dragged flush against the edge would come back a hair narrower than its
 * preset (and, being a fractional width, blurrier). A genuinely
 * doesn't-fit panel misses by whole pixels, so this can't mask one.
 */
const FIT_EPSILON_PX = 0.01

/** The preset size when it fits (within `FIT_EPSILON_PX`), else exactly the room left. */
function fitToRoom(targetPx: number, roomPx: number): number {
  return Math.max(0, roomPx + FIT_EPSILON_PX >= targetPx ? targetPx : roomPx)
}

/**
 * Position + size CSS for a panel anchored at its top-left corner. The
 * preset size is a target, capped by how much room is actually left before
 * the panel would run past the window's right/bottom edge - this only
 * matters if the anchor point sits close to an edge, but it's what keeps a
 * panel from getting clipped or pushed off-screen if the overlay window
 * (i.e. the game window) shrinks after the layout was saved.
 *
 * That window-shrink case is the *only* thing this cap is for. Dragging can
 * no longer walk a panel into it: `anchorFromPointer` bounds the anchor to
 * the range where the preset size still fits, so a drag never changes the
 * size it returns (see that function for why that matters).
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
    width: fitToRoom(targetSizePx.width, maxWidthPx),
    height: fitToRoom(targetSizePx.height, maxHeightPx)
  }
}

/**
 * Converts a pointer position (window-relative) into an anchor coordinate
 * clamped to the range where the panel still fits *whole* on the canvas -
 * i.e. 0 to `(canvas - panel) / canvas`, not 0 to 100%.
 *
 * Bounding the *position* here is what keeps `panelStyle`'s size cap above
 * from firing mid-drag. Clamping only to 0-100% (the original behaviour) let
 * the corner be dragged into the region where the remaining room is smaller
 * than the preset size, so the panel visibly squashed as it moved and, worse,
 * `PanelFrame.handleMove` had to write a new `width`/`height` on *every*
 * mousemove - a full layout + repaint of the panel subtree per frame,
 * defeating the compositor-only `transform` drag it sits next to. That zone
 * is as large as the panel, so the effect scaled with panel size: a 620x560
 * `dpsDetail` on a 1920x1080 client had ~67% of the screen area in it (vs a
 * thin edge strip for the ~380x220 panels), which is why that one panel
 * dragged badly while the rest felt fine.
 *
 * A panel larger than the canvas clamps to 0 and stays flush with the
 * top/left edge; `panelStyle`'s cap then shrinks it to fit, which is the
 * window-shrink case that cap exists for.
 */
export function anchorFromPointer(
  clientX: number,
  clientY: number,
  canvasSizePx: SizePx,
  panelSizePx: SizePx
): { x: number; y: number } {
  const axis = (client: number, canvas: number, panel: number): number => {
    if (canvas <= 0) return 0
    const max = Math.max(0, (canvas - panel) / canvas)
    return Math.min(Math.max(client / canvas, 0), max) * 100
  }
  return {
    x: axis(clientX, canvasSizePx.width, panelSizePx.width),
    y: axis(clientY, canvasSizePx.height, panelSizePx.height)
  }
}
