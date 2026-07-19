import { useDpsGraph } from './dps/useDpsGraph'
import { SPARKLINE_HEIGHT } from './dps/rowLayout'
import { formatDps } from './formatDps'

/**
 * The DPS panel's trend line (PRD §4, docs/prd-dps-graph.md): the local
 * player's damage rate aggregated across all targets over the trailing
 * ~10s, trailing-average smoothed. Bare inline SVG - no axes, no gridlines,
 * no legend (single series; the panel context names it) - with one direct
 * label: the current smoothed value, in text tokens (never the series
 * color). Updates arrive at bin cadence from `useDpsGraph`; there is
 * deliberately no CSS transition or rAF animation (see the PRD's
 * smooth-scroll upgrade-path note - a perpetual animation would keep the
 * compositor busy over the game).
 *
 * Layering contract (PRD §4, binding): this component is the only place the
 * graph's presentation lives - a restyle or a switch to continuous scrolling
 * touches this file alone, never the recorder or tracker.
 */

const VIEW_W = 100
const VIEW_H = 32
/** Top padding inside the viewBox so the line's peak never clips. */
const HEADROOM = 0.1

function DpsSparkline(): React.JSX.Element {
  const series = useDpsGraph()
  const { points, windowMax, current } = series

  const yMax = windowMax > 0 ? windowMax * (1 + HEADROOM) : 1
  const step = VIEW_W / (points.length - 1)
  const coords = points.map((v, i) => {
    const x = i * step
    const y = VIEW_H - (v / yMax) * VIEW_H
    return `${x.toFixed(2)},${y.toFixed(2)}`
  })
  const line = coords.join(' ')
  const area = `M0,${VIEW_H} L${coords.join(' L')} L${VIEW_W},${VIEW_H} Z`

  return (
    <div
      className="flex shrink-0 items-end gap-1.5"
      style={{ height: SPARKLINE_HEIGHT }}
      data-testid="dps-sparkline"
    >
      <svg
        className="h-full min-w-0 flex-1 text-accent"
        viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <path d={area} fill="currentColor" fillOpacity={0.15} stroke="none" />
        <polyline
          points={line}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
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
