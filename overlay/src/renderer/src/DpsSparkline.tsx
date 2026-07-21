import { useLayoutEffect, useRef } from 'react'
import { graphCoords, smoothAreaD, smoothLineD } from './dps/graphCurve'
import { useDpsGraph } from './dps/useDpsGraph'
import { formatDps } from './formatDps'

/**
 * The DPS trend graph's presentation (PRD §4, docs/prd-dps-graph.md), now the
 * sole content of the standalone `dpsGraph` panel (issue #259) rather than
 * embedded in the DPS panel: the local player's damage rate aggregated
 * across all targets over the trailing ~10s, trailing-average smoothed, with
 * one direct label - the current smoothed value, in text tokens (never the
 * series color). Updates arrive at bin cadence from `useDpsGraph`.
 *
 * Layering contract (PRD §4, binding): this component (plus the pure curve
 * math factored into `dps/graphCurve.ts` for Fast Refresh - see that file's
 * doc comment) is the only place the graph's presentation lives - a restyle
 * or a switch to continuous scrolling touches these files alone, never the
 * recorder or tracker. This is that switch: the line is now a curve
 * (`smoothLineD`/`smoothAreaD`) and new bins slide in via the PRD's
 * sanctioned smooth-scroll upgrade path.
 *
 * The path data (`lineD`/`areaD`) is plain, declarative render output -
 * always computed straight from this render's `points`/`windowMax`, same as
 * the pre-#259 polyline was, so it's never stale relative to what
 * `useDpsGraph` just delivered. Only the slide *transform* is imperative
 * (a ref-driven `useLayoutEffect`): a compositor-only CSS transition,
 * restarted once per bin tick via a single (non-looping)
 * `requestAnimationFrame` - never a perpetual rAF loop, and narrow enough in
 * scope that React StrictMode's dev-only double-invoke of effects can't
 * desync it from the data (unlike an earlier version of this component that
 * also drove the path data through the same effect - see git history).
 *
 * The effect keys off `series.bin`, not `points`: `useDpsGraph` re-reads the
 * recorder on every bridge `dps` envelope (as often as
 * PacketBridge.DPS_COALESCE_MS=50ms), so `points` gets a fresh array identity
 * well inside one BIN_MS(250) bin, while `bin` (the recorder's `curBin`)
 * only advances once a real bin tick closes. Keying the slide on `points`
 * restarted it up to ~5x per bin during sustained combat, so the group never
 * reached rest and the curve visibly vibrated instead of scrolling.
 * Intra-bin refreshes still redraw the path immediately (computed straight
 * from this render's `points` above), just without re-triggering the
 * transform.
 */

const VIEW_W = 100
const VIEW_H = 32
/** Top padding inside the viewBox so the line's peak never clips. */
const HEADROOM = 0.1
/** Compositor transform duration for one bin's worth of slide - shorter than
 * BIN_MS (250) so a tick's animation always finishes before the next starts. */
const SLIDE_MS = 220

function DpsSparkline(): React.JSX.Element {
  const series = useDpsGraph()
  const { points, windowMax, current, bin } = series

  const step = VIEW_W / (points.length - 1)
  const yMax = windowMax > 0 ? windowMax * (1 + HEADROOM) : 1
  // One extra bin - a duplicate of the current oldest point - prepended so
  // the group can rest one step-width right of its final (settled)
  // position and slide left into place, without a gap at the left edge
  // while it's mid-slide. The settled coordinates (indices 1..N below,
  // reached at transform=0) are always exactly this render's true series;
  // the duplicate only ever shows on the first frame of an in-flight slide,
  // and a screenshot (which disables transitions - e2e/shots.spec.ts) always
  // lands on the settled position, so it never affects committed evidence.
  const renderPoints = [points[0], ...points]
  const coords = graphCoords(renderPoints, step, -step, yMax, VIEW_H)
  const lineD = smoothLineD(coords)
  const areaD = smoothAreaD(coords, VIEW_H)

  const groupRef = useRef<SVGGElement>(null)
  const mountedRef = useRef(false)

  useLayoutEffect(() => {
    const group = groupRef.current
    if (!group) return

    if (!mountedRef.current) {
      mountedRef.current = true
      group.style.transition = 'none'
      group.setAttribute('transform', 'translate(0 0)')
      return
    }

    // Snap to the slide's start position with no transition, then flip to
    // rest on the next paint so the browser animates the transform over
    // SLIDE_MS. One-shot per bin tick - the transform is static between
    // ticks, so an idle overlay (the hook skips updates while flat at zero)
    // never animates at all.
    group.style.transition = 'none'
    group.setAttribute('transform', `translate(${step} 0)`)
    const raf = requestAnimationFrame(() => {
      group.style.transition = `transform ${SLIDE_MS}ms linear`
      group.setAttribute('transform', 'translate(0 0)')
    })
    return () => cancelAnimationFrame(raf)
    // Deliberately keyed on `bin`, not `points` - see the doc comment above.
  }, [bin, step])

  return (
    <div className="flex h-full w-full items-end gap-1.5" data-testid="dps-sparkline">
      <svg
        className="h-full min-w-0 flex-1 text-accent"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        style={{ overflow: 'hidden' }}
        aria-hidden="true"
      >
        <g ref={groupRef} style={{ willChange: 'transform' }}>
          <path d={areaD} fill="currentColor" fillOpacity={0.15} stroke="none" />
          <path
            d={lineD}
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />
        </g>
      </svg>
      {current > 0 && (
        <span className="shrink-0 font-mono text-2xs tabular-nums text-fg-muted">
          {formatDps(current)}/s
        </span>
      )}
    </div>
  )
}

export default DpsSparkline
