import { useEffect, useRef } from 'react'
import { subscribeAnimClock } from './animClock'
import {
  createDyeFrameScratch,
  renderDyeFrame,
  type DyeBake,
  type DyeFrameScratch
} from './dyeBake'

interface AnimatedDyeCanvasProps {
  bake: DyeBake
  size: number
  scrollSpeed: number
  rotateSpeed: number
  className?: string
}

/**
 * Renders a dyeAnimated sprite (continuous scroll/rotate cloth motion) by
 * subscribing to the shared rAF clock and recompositing the pre-baked layers
 * onto a <canvas> every frame - no React re-render, no toDataURL encode, no
 * per-frame pixel readback (see dyeBake.ts for the compositing itself).
 */
export function AnimatedDyeCanvas({
  bake,
  size,
  scrollSpeed,
  rotateSpeed,
  className
}: AnimatedDyeCanvasProps): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scratchRef = useRef<DyeFrameScratch | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const scratch = scratchRef.current
    if (
      !scratch ||
      scratch.accumulator.width !== bake.ow ||
      scratch.accumulator.height !== bake.oh
    ) {
      scratchRef.current = createDyeFrameScratch(bake.ow, bake.oh)
    }
    return subscribeAnimClock((now) => {
      // now (DOMHighResTimeStamp, ms) is shared across every subscriber, so
      // every animated sprite on screen renders the same phase - keeping
      // multiple rows (e.g. a DPS panel) in sync.
      renderDyeFrame(canvas, bake, now / 1000, scrollSpeed, rotateSpeed, scratchRef.current!)
    })
  }, [bake, scrollSpeed, rotateSpeed])

  return (
    <canvas
      ref={canvasRef}
      width={size}
      height={size}
      className={className}
      style={{ imageRendering: 'pixelated' }}
    />
  )
}
