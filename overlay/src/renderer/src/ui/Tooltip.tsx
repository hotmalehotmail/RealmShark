import { useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useInteractive } from './interactiveContext'

// Short hover-intent delay: long enough that sweeping the cursor across a row
// of item sprites doesn't flash a tooltip on each one, short enough to feel
// immediate. 300ms (the old value) read as sluggish.
const SHOW_DELAY_MS = 120
const VIEWPORT_MARGIN = 8
const TRIGGER_GAP = 4

type Phase = 'hidden' | 'measuring' | 'shown'

interface TooltipProps {
  /** Tooltip body. Only evaluated while hovering, so it's cheap to pass a fresh element every render. */
  content: React.ReactNode
  children: React.ReactNode
  /** Layout-only (see docs/overlay-ui-style.md) - applied to the trigger wrapper, not the tooltip bubble. */
  className?: string
}

/**
 * Hover tooltip for any element. Portals its content to `document.body` so it
 * always escapes a panel's clipping (`PanelFrame`'s frame is
 * `overflow-hidden`, its content wrapper `overflow-auto` - see
 * `docs/overlay-renderer.md` §2), and viewport-clamps its own position so it
 * can never run off the overlay window regardless of where the trigger sits.
 * <p>
 * Positioning is two-pass: on hover (after `SHOW_DELAY_MS`) the bubble first
 * mounts off-screen-but-in-the-DOM (`measuring`) so its real rendered size can
 * be read, then is repositioned and revealed (`shown`) - simpler and more
 * accurate than guessing a fixed max size up front.
 * <p>
 * Gated on interactive mode ({@link useInteractive}): PanelFrame already
 * makes a non-interactive panel's whole DOM subtree `pointer-events-none`, so
 * a trigger inside one never receives a hover event in the first place - but
 * this component's portal renders into `document.body`, *outside* that
 * subtree, so it can't rely on inheriting that CSS. Instead, when not
 * interactive, it renders `children` completely unwrapped (no extra div, no
 * listeners, no portal) - the click-through contract is preserved by never
 * attaching a hover target at all, not by hiding one.
 */
export function Tooltip({ content, children, className }: TooltipProps): React.JSX.Element {
  const interactive = useInteractive()
  const [phase, setPhase] = useState<Phase>('hidden')
  const [pos, setPos] = useState<{ x: number; y: number }>({ x: -9999, y: -9999 })
  const triggerRef = useRef<HTMLDivElement>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const show = (): void => {
    timerRef.current = setTimeout(() => setPhase('measuring'), SHOW_DELAY_MS)
  }
  const hide = (): void => {
    clearTimeout(timerRef.current)
    setPhase('hidden')
  }

  useLayoutEffect(() => {
    if (phase !== 'measuring' || !triggerRef.current || !bubbleRef.current) return
    const trigger = triggerRef.current.getBoundingClientRect()
    const bubble = bubbleRef.current.getBoundingClientRect()

    let x = trigger.left
    x = Math.min(x, window.innerWidth - bubble.width - VIEWPORT_MARGIN)
    x = Math.max(VIEWPORT_MARGIN, x)

    let y = trigger.bottom + TRIGGER_GAP
    if (y + bubble.height > window.innerHeight - VIEWPORT_MARGIN) {
      y = trigger.top - bubble.height - TRIGGER_GAP
    }
    y = Math.max(VIEWPORT_MARGIN, y)

    setPos({ x, y })
    setPhase('shown')
  }, [phase])

  if (!interactive) return <>{children}</>

  return (
    <div
      ref={triggerRef}
      className={`inline-flex ${className ?? ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      {children}
      {phase !== 'hidden' &&
        createPortal(
          <div
            ref={bubbleRef}
            className="pointer-events-none fixed z-[9999] max-w-[240px] rounded-md border border-edge bg-panel px-2 py-1.5 text-xs text-fg shadow-lg backdrop-blur-sm"
            style={{
              left: pos.x,
              top: pos.y,
              visibility: phase === 'shown' ? 'visible' : 'hidden'
            }}
          >
            {content}
          </div>,
          document.body
        )}
    </div>
  )
}
