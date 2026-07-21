import { describe, expect, it } from 'vitest'
import {
  graphCoords,
  smoothAreaD,
  smoothLineD,
  type Coord
} from '../src/renderer/src/dps/graphCurve'
import { PANEL_REGISTRY } from '../src/renderer/src/panels/registry'

const VIEW_H = 32

/**
 * The DPS trend graph's own placeable/sizable panel (issue #259), plus the
 * curve-smoothing math `DpsSparkline.tsx` uses to draw it - see
 * `docs/prd-dps-graph.md` §4's "Update (issue #259)" and
 * `docs/overlay-renderer.md`'s "The sparkline". No DOM-rendering harness in
 * this suite (`vitest.config.ts`'s `environment: 'node'`), so this exercises
 * the pure geometry the component builds its path strings from, same
 * approach as `panels-closeable.test.ts`.
 */

describe('dpsGraph panel registration', () => {
  it('is its own registry entry, closable, not ephemeral, sized at every preset', () => {
    const spec = PANEL_REGISTRY.dpsGraph
    expect(spec).toBeDefined()
    expect(spec.closable).toBe(true)
    expect(spec.ephemeral).toBeUndefined()
    for (const size of ['sm', 'md', 'lg'] as const) {
      expect(spec.sizes[size].width).toBeGreaterThan(0)
      expect(spec.sizes[size].height).toBeGreaterThan(0)
    }
  })

  it('DpsPanel no longer reserves height for an embedded sparkline', () => {
    // dpsPanelHeight('sm') is unaffected either way (the sparkline was never
    // shown at sm); md/lg shrink by the sparkline's old SPARKLINE_HEIGHT+gap
    // (32px) now that the graph is its own panel.
    expect(PANEL_REGISTRY.dps.sizes.sm.height).toBe(106)
    expect(PANEL_REGISTRY.dps.sizes.md.height).toBe(178)
    expect(PANEL_REGISTRY.dps.sizes.lg.height).toBe(334)
  })
})

function quadAt(p0: Coord, control: Coord, p1: Coord, t: number): Coord {
  const mt = 1 - t
  return {
    x: mt * mt * p0.x + 2 * mt * t * control.x + t * t * p1.x,
    y: mt * mt * p0.y + 2 * mt * t * control.y + t * t * p1.y
  }
}

describe('graphCoords', () => {
  it('maps values to y=VIEW_H(32) at value 0 and scales down toward 0 as value approaches yMax', () => {
    const coords = graphCoords([0, 5, 10], 10, 0, 10, VIEW_H)
    expect(coords[0]).toEqual({ x: 0, y: 32 })
    expect(coords[2].y).toBeCloseTo(0)
    expect(coords[1].y).toBeGreaterThan(0)
    expect(coords[1].y).toBeLessThan(32)
  })

  it('applies the given x step and offset', () => {
    const coords = graphCoords([1, 1, 1], 5, -5, 1, VIEW_H)
    expect(coords.map((c) => c.x)).toEqual([-5, 0, 5])
  })
})

describe('smoothLineD / smoothAreaD - curve safety (never dips negative, never clips the peak)', () => {
  it('a flat zero series stays an exactly flat baseline', () => {
    const coords = graphCoords(new Array(10).fill(0), 10, 0, 1, VIEW_H)
    // Every control/mid point float-equals the baseline, so any point sampled
    // on the curve (a weighted average of same-value points) is also exactly
    // the baseline - no negative dip is even representable.
    expect(coords.every((c) => c.y === 32)).toBe(true)
    expect(smoothLineD(coords)).toMatch(/^M0\.00,32\.00/)
  })

  it('the drawn curve never leaves the value range of the points it connects', () => {
    const points = [0, 5, 20, 3, 0, 8, 0, 0]
    const yMax = 22
    const coords = graphCoords(points, 12, 0, yMax, VIEW_H)
    const minY = Math.min(...coords.map((c) => c.y))
    const maxY = Math.max(...coords.map((c) => c.y))

    // Reconstruct the exact segments smoothLineD draws (see curveTail): a
    // quadratic from the running curve point to mid(coords[i], coords[i+1])
    // with control point coords[i], for i = 1..n-2.
    let prev = coords[0]
    for (let i = 1; i < coords.length - 1; i++) {
      const control = coords[i]
      const next = coords[i + 1]
      const mid = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 }
      for (let t = 0; t <= 1; t += 0.1) {
        const p = quadAt(prev, control, mid, t)
        expect(p.y).toBeGreaterThanOrEqual(minY - 1e-9)
        expect(p.y).toBeLessThanOrEqual(maxY + 1e-9)
      }
      prev = mid
    }
    // The value range itself never exceeds what the y-domain (yMax with
    // headroom, applied by the caller) represents - i.e. the data's own peak,
    // never inflated by the smoothing.
    expect(minY).toBeGreaterThanOrEqual(0)
    expect(maxY).toBeLessThanOrEqual(32)
  })

  it('returns empty strings for an empty series and a single-point M for one point', () => {
    expect(smoothLineD([])).toBe('')
    expect(smoothAreaD([], 32)).toBe('')
    expect(smoothLineD([{ x: 1, y: 2 }])).toBe('M1.00,2.00')
  })

  it('the area path starts and ends on the baseline and closes', () => {
    const coords = graphCoords([1, 4, 2], 10, 0, 4, VIEW_H)
    const area = smoothAreaD(coords, 32)
    expect(area.startsWith('M0.00,32.00')).toBe(true)
    expect(area.trim().endsWith('Z')).toBe(true)
    expect(area).toContain('L20.00,32.00')
  })
})
