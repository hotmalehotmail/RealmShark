/**
 * Pure geometry for `DpsSparkline.tsx`'s curve (PRD §4 update, issue #259) -
 * split into its own module (not exported from the component file) only
 * because a component file can't also export plain functions without
 * breaking Fast Refresh (`react-refresh/only-export-components`), same
 * reason `dps/dpsDetailContext.ts` is split from its provider. This is still
 * presentation math, not the recorder/tracker - the binding layering
 * contract (PRD §4) holds: only `DpsSparkline.tsx` and this file know the
 * graph draws a curve at all.
 */

export interface Coord {
  x: number
  y: number
}

export function graphCoords(
  points: number[],
  step: number,
  xOffset: number,
  yMax: number,
  viewH: number
): Coord[] {
  return points.map((v, i) => ({
    x: xOffset + i * step,
    y: viewH - (v / yMax) * viewH
  }))
}

function curveTail(coords: Coord[]): string {
  if (coords.length < 2) return ''
  let d = ''
  for (let i = 1; i < coords.length - 1; i++) {
    const cur = coords[i]
    const next = coords[i + 1]
    const midX = (cur.x + next.x) / 2
    const midY = (cur.y + next.y) / 2
    d += ` Q${cur.x.toFixed(2)},${cur.y.toFixed(2)} ${midX.toFixed(2)},${midY.toFixed(2)}`
  }
  const last = coords[coords.length - 1]
  d += ` L${last.x.toFixed(2)},${last.y.toFixed(2)}`
  return d
}

/**
 * Smooth SVG path through every point in `coords`, via a quadratic Bezier to
 * each segment's midpoint (control point = the actual data point). Each
 * curve segment is bounded by the convex hull of its own control points, all
 * of which come straight from the (non-negative) data - so the curve can
 * never dip below the lowest value it connects (a flat zero line stays
 * flat, never a negative dip) or rise above the highest one (the peak never
 * clips), unlike a Catmull-Rom-style spline that can overshoot past its
 * inputs.
 */
export function smoothLineD(coords: Coord[]): string {
  if (coords.length === 0) return ''
  if (coords.length === 1) return `M${coords[0].x.toFixed(2)},${coords[0].y.toFixed(2)}`
  const first = coords[0]
  return `M${first.x.toFixed(2)},${first.y.toFixed(2)}${curveTail(coords)}`
}

/** Same curve as `smoothLineD`, closed down to `baselineY` for the area fill. */
export function smoothAreaD(coords: Coord[], baselineY: number): string {
  if (coords.length === 0) return ''
  const first = coords[0]
  const last = coords[coords.length - 1]
  return (
    `M${first.x.toFixed(2)},${baselineY.toFixed(2)} L${first.x.toFixed(2)},${first.y.toFixed(2)}` +
    `${curveTail(coords)} L${last.x.toFixed(2)},${baselineY.toFixed(2)} Z`
  )
}
