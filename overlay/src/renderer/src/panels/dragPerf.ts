/**
 * TEMPORARY DIAGNOSTIC (drag-perf investigation) — remove once the drag-lag
 * root cause is confirmed and the real fix lands.
 *
 * `PanelFrame`'s imperative drag already avoids per-move React re-renders, yet
 * dragging still felt laggy. The prime suspect is paint/compositor cost, not
 * JS: hardware acceleration is disabled (`main/index.ts` — needed for overlay
 * transparency), so every panel's `backdrop-filter: blur()` + `box-shadow` is
 * recomposited on the CPU each frame a panel moves.
 *
 * This measures the actual per-frame cadence during a drag (via
 * requestAnimationFrame deltas — which stretch out when the compositor can't
 * keep up) and logs a one-line summary on drop, into the Console panel. Holding
 * **Shift** while dragging additionally suspends the panels' blur + shadow (the
 * `diag-suspend-blur` rule in `assets/main.css`), so a normal drag vs. a
 * Shift-drag is a direct A/B on whether backdrop-filter is the bottleneck.
 * Must be tested on the real client with the game running — the cost is
 * software-compositing + GPU/CPU contention, which won't reproduce headless.
 */

const SUSPEND_BLUR_CLASS = 'diag-suspend-blur'

export interface DragPerfSession {
  /** Stop sampling, restore blur, and log the summary. */
  stop(): void
}

export function startDragPerf(suspendBlur: boolean): DragPerfSession {
  const root = document.documentElement
  if (suspendBlur) root.classList.add(SUSPEND_BLUR_CLASS)

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
      if (suspendBlur) root.classList.remove(SUSPEND_BLUR_CLASS)
      logSummary(frames, performance.now() - started, suspendBlur)
    }
  }
}

function logSummary(frames: number[], durationMs: number, blurSuspended: boolean): void {
  if (frames.length < 3) {
    console.log(`[drag-perf] blurSuspended=${blurSuspended} — drag too short to sample`)
    return
  }
  const sorted = [...frames].sort((a, b) => a - b)
  const percentile = (p: number): number =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]
  const avg = frames.reduce((a, b) => a + b, 0) / frames.length
  const janky16 = frames.filter((f) => f > 16.7).length
  const janky33 = frames.filter((f) => f > 33).length
  console.log(
    `[drag-perf] blurSuspended=${blurSuspended} dur=${durationMs.toFixed(0)}ms ` +
      `frames=${frames.length} avg=${avg.toFixed(1)}ms(~${(1000 / avg).toFixed(0)}fps) ` +
      `p50=${percentile(50).toFixed(1)} p95=${percentile(95).toFixed(1)} ` +
      `max=${sorted[sorted.length - 1].toFixed(1)}ms janky>16.7=${janky16} janky>33=${janky33}`
  )
}
