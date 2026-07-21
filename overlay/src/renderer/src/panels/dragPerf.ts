/**
 * Per-frame cadence sampling for an active panel drag, logged to the Console
 * panel on drop. `PanelFrame` starts a session on every drag and stops it on
 * drop; this is the successor to the ad-hoc drag-perf diagnostic from #132
 * (which A/B'd blur suspension via a Shift-drag) - blur/shadow suspension is
 * now unconditional (see the `panel-dragging` rule in `assets/main.css`), so
 * this only measures, it no longer toggles anything. Useful for catching a
 * future regression in drag smoothness (frame time should track the
 * display's refresh interval with no multi-frame stalls).
 */

/** Mirrors DPS_DEBUG (DpsTracker.ts) - flip locally to enable, e.g. for an
 * alpha-soak drag-smoothness check. Off by default so a normal drag doesn't
 * log to the Console panel; disabled sessions skip the rAF sampling loop
 * entirely, not just the log. AND-ed with the caller's `devMode` (issue
 * #265, docs/dev-mode.md) so this stays fully inert for every ordinary user
 * regardless of this constant - a maintainer wanting a soak-PC drag-smoothness
 * check still has to flip this to true locally AND have dev mode on. */
export const DRAG_PERF_DEBUG = false

export interface DragPerfSession {
  /** Stop sampling and log the summary. */
  stop(): void
}

const NOOP_SESSION: DragPerfSession = { stop: (): void => undefined }

export function startDragPerf(devMode: boolean): DragPerfSession {
  if (!devMode || !DRAG_PERF_DEBUG) return NOOP_SESSION

  const frames: number[] = []
  const started = performance.now()
  let last = started
  let seenFirst = false
  let rafId = requestAnimationFrame(function tick(now: number): void {
    // Skip the first delta (mousedown → first frame): not representative of the
    // steady-state drag cadence.
    if (seenFirst) frames.push(now - last)
    seenFirst = true
    last = now
    rafId = requestAnimationFrame(tick)
  })

  return {
    stop(): void {
      cancelAnimationFrame(rafId)
      logSummary(frames, performance.now() - started)
    }
  }
}

function logSummary(frames: number[], durationMs: number): void {
  if (frames.length < 3) {
    console.log(`[drag-perf] dur=${durationMs.toFixed(0)}ms — drag too short to sample`)
    return
  }
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length
  const janky16 = frames.filter((f) => f > 16.7).length
  const janky33 = frames.filter((f) => f > 33).length
  console.log(
    `[drag-perf] dur=${durationMs.toFixed(0)}ms frames=${frames.length} ` +
      `avg=${avg.toFixed(1)}ms(~${(1000 / avg).toFixed(0)}fps) ` +
      `p50=${percentile(50).toFixed(1)} p95=${percentile(95).toFixed(1)} ` +
      `max=${sorted[sorted.length - 1].toFixed(1)}ms janky>16.7=${janky16} janky>33=${janky33}`
  )
}
