import { describe, expect, it } from 'vitest'
import { anchorFromPointer, panelStyle } from '../src/renderer/src/panels/anchor'
import { PANEL_REGISTRY } from '../src/renderer/src/panels/registry'

// A 1920x1080 game client - the size the regression below was measured on.
const CANVAS = { width: 1920, height: 1080 }
const DPS_DETAIL_LG = PANEL_REGISTRY.dpsDetail.sizes.lg

/**
 * The drag-lag regression: `panelStyle` caps a panel's size to the room left
 * between its anchor and the canvas's right/bottom edge, and `handleMove`
 * recomputes it every mousemove. While `anchorFromPointer` clamped only to
 * 0-100%, dragging a panel into the bottom-right walked it straight into that
 * cap, so every frame wrote a new width/height - a full layout + repaint of
 * the panel subtree, defeating the compositor-only transform drag next to it
 * (measured: ~6x the layout and ~13x the paint work of the same drag in the
 * unclamped region, panel squashed 620x560 -> 440x268 mid-drag).
 *
 * The fix bounds the *position* instead: the anchor can only reach the point
 * where the panel still fits whole. `panelStyle`'s cap stays for the case it
 * was written for (the game window shrinking under an already-saved layout),
 * but a drag can no longer reach it.
 */
describe('anchorFromPointer - drag never resizes a panel', () => {
  it('holds the preset size at every anchor a drag can produce', () => {
    // Sweep the whole canvas, including well past the point where a 620x560
    // panel stops fitting (x > 67.7%, y > 48.1%).
    for (let clientX = 0; clientX <= CANVAS.width; clientX += 20) {
      for (let clientY = 0; clientY <= CANVAS.height; clientY += 20) {
        const anchor = anchorFromPointer(clientX, clientY, CANVAS, DPS_DETAIL_LG)
        const style = panelStyle({ pos: 'tl', ...anchor }, DPS_DETAIL_LG, CANVAS)
        expect(style.width).toBe(DPS_DETAIL_LG.width)
        expect(style.height).toBe(DPS_DETAIL_LG.height)
      }
    }
  })

  it('stops the panel flush with the right/bottom edge instead of past it', () => {
    const anchor = anchorFromPointer(CANVAS.width * 2, CANVAS.height * 2, CANVAS, DPS_DETAIL_LG)
    expect(anchor.x).toBeCloseTo(((1920 - 620) / 1920) * 100, 6)
    expect(anchor.y).toBeCloseTo(((1080 - 560) / 1080) * 100, 6)

    // Flush: anchor% of the canvas, plus the panel's own size, is exactly the
    // canvas - the panel is fully on screen with nothing to spare.
    expect((anchor.x / 100) * CANVAS.width + DPS_DETAIL_LG.width).toBeCloseTo(CANVAS.width, 6)
    expect((anchor.y / 100) * CANVAS.height + DPS_DETAIL_LG.height).toBeCloseTo(CANVAS.height, 6)
  })

  it('still clamps the top/left edge at 0', () => {
    expect(anchorFromPointer(-500, -500, CANVAS, DPS_DETAIL_LG)).toEqual({ x: 0, y: 0 })
  })

  it('every registered panel/size combo is draggable without resizing', () => {
    for (const spec of Object.values(PANEL_REGISTRY)) {
      for (const size of ['sm', 'md', 'lg'] as const) {
        const target = spec.sizes[size]
        const anchor = anchorFromPointer(CANVAS.width, CANVAS.height, CANVAS, target)
        const style = panelStyle({ pos: 'tl', ...anchor }, target, CANVAS)
        expect(`${spec.type}/${size}: ${String(style.width)}x${String(style.height)}`).toBe(
          `${spec.type}/${size}: ${target.width}x${target.height}`
        )
      }
    }
  })

  it('pins a panel larger than the canvas to the top/left, letting panelStyle cap it', () => {
    // The window-shrink case panelStyle's cap exists for: no anchor can make a
    // 620x560 panel fit a 400x300 window, so it sits at 0,0 and gets capped.
    const tiny = { width: 400, height: 300 }
    const anchor = anchorFromPointer(999, 999, tiny, DPS_DETAIL_LG)
    expect(anchor).toEqual({ x: 0, y: 0 })
    const style = panelStyle({ pos: 'tl', ...anchor }, DPS_DETAIL_LG, tiny)
    expect(style.width).toBe(tiny.width)
    expect(style.height).toBe(tiny.height)
  })

  it('does not divide by a zero canvas (pre-measurement first render)', () => {
    expect(anchorFromPointer(100, 100, { width: 0, height: 0 }, DPS_DETAIL_LG)).toEqual({
      x: 0,
      y: 0
    })
  })
})
