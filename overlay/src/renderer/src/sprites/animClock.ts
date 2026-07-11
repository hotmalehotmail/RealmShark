/**
 * Single shared requestAnimationFrame loop for continuous animated-dye motion
 * (scroll/rotate). Every animated-cloth sprite subscribes to the same clock
 * instead of driving its own timer, so multiple sprites stay perfectly in
 * sync (e.g. several DPS-list rows) and the loop is vsync-aligned rather than
 * a coarse setInterval tick. Starts on first subscriber, stops on last
 * unsubscribe - idle when nothing is animating.
 */

type AnimClockListener = (now: DOMHighResTimeStamp) => void

const listeners = new Set<AnimClockListener>()
let rafId: number | null = null

function tick(now: DOMHighResTimeStamp): void {
  for (const listener of listeners) listener(now)
  rafId = requestAnimationFrame(tick)
}

/** Subscribe to the shared clock; returns an unsubscribe function. */
export function subscribeAnimClock(listener: AnimClockListener): () => void {
  listeners.add(listener)
  if (rafId == null) rafId = requestAnimationFrame(tick)
  return () => {
    listeners.delete(listener)
    if (listeners.size === 0 && rafId != null) {
      cancelAnimationFrame(rafId)
      rafId = null
    }
  }
}
