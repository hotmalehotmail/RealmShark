import { useEffect, useRef, useState } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import { Button } from '../ui/Button'
import { anchorFromPointer, panelStyle, type SizePx } from './anchor'
import { startDragPerf } from './dragPerf'
import type { PanelSpec } from './registry'

const SIZE_CYCLE: Record<PanelSize, PanelSize> = { sm: 'md', md: 'lg', lg: 'sm' }

/** Toggled on <html> for the duration of any panel drag - see main.css. */
const DRAGGING_CLASS = 'panel-dragging'

interface PanelFrameProps {
  panel: PanelInstance
  spec: PanelSpec
  canvasSize: SizePx
  /** Whether the overlay is in interactive mode (panels are draggable and can capture input). */
  interactive: boolean
  onDrag: (id: string, x: number, y: number) => void
  onCycleSize: (id: string) => void
  onTogglePin: (id: string) => void
  onBringToTop: (id: string) => void
  /** Only rendered as a title-bar control when `spec.closable` is set. */
  onClose: (id: string) => void
}

function PanelFrame({
  panel,
  spec,
  canvasSize,
  interactive,
  onDrag,
  onCycleSize,
  onTogglePin,
  onBringToTop,
  onClose
}: PanelFrameProps): React.JSX.Element {
  const Content = spec.component
  const Settings = spec.settings
  // Frame-local (issue #221, PRD §5 "the per-panel gear"): flips this
  // panel's body in place to its settings view, independent of every other
  // panel's state. Persists across an interactive-mode toggle exactly like
  // pin/size do (§2 of docs/overlay-renderer.md: panels keep their live
  // state across toggles) - the gear itself is only reachable while
  // interactive, so this can only be true when the panel was last flipped
  // open by the user.
  const [showSettings, setShowSettings] = useState(false)
  const draggingRef = useRef(false)
  const frameRef = useRef<HTMLDivElement>(null)
  // Set to the in-flight drag's handleUp while dragging, so an external abort
  // (see the effect below) can end it the same way a mouseup would.
  const endDragRef = useRef<(() => void) | null>(null)

  // The preload-side packet-suspend failsafe (interactive-change=false /
  // overlay-detach) guards against a drag whose mouseup never reaches the
  // renderer (hotkey toggle mid-drag can setIgnoreMouseEvents before the
  // mouseup lands; the game closing mid-drag is the detach case). Mirror it
  // here for the renderer-side visual drag state - otherwise `panel-dragging`
  // would stay on <html> (blur/shadow suspended at rest) and the dragged
  // frame would keep a stale transform, both self-healing only on the next
  // completed drag.
  useEffect(() => {
    const offInteractive = window.overlay.onInteractiveChange((stillInteractive) => {
      if (!stillInteractive) endDragRef.current?.()
    })
    const offDetach = window.overlay.onOverlayDetach(() => endDragRef.current?.())
    return () => {
      offInteractive()
      offDetach()
    }
  }, [])

  const startDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    onBringToTop(panel.id)
    draggingRef.current = true

    const perf = startDragPerf()

    // Suspend every panel's blur/shadow and the packet-stream content updates
    // (DPS/loot/entity-registry re-renders) for the drag's duration - both
    // compete with the drag for the main thread. Restored/flushed in handleUp.
    document.documentElement.classList.add(DRAGGING_CLASS)
    window.overlay.setPacketBatchSuspended(true)

    // Keep the cursor over the same point of the panel it grabbed, instead
    // of snapping the panel's corner to wherever the cursor happens to be.
    const rect = frameRef.current!.getBoundingClientRect()
    const grabOffsetX = e.clientX - rect.left
    const grabOffsetY = e.clientY - rect.top
    frameRef.current!.style.willChange = 'transform'

    // Drag imperatively (#120): write the moved panel's position straight to
    // the DOM on each mousemove rather than round-tripping through React
    // state, which would re-render PanelCanvas and every panel's (sprite-
    // rendering) content ~60-125x/sec. On top of that, move the panel with a
    // `transform` instead of rewriting `left`/`top` every frame - transform
    // is compositor-only (no layout/repaint), whereas left/top forces a full
    // layout + repaint each frame even with blur/shadow suspended. `left`/
    // `top` stay at their rest values for the whole drag, and `width`/
    // `height` cannot change during one at all (anchorFromPointer keeps the
    // panel inside the region where its preset size fits, so panelStyle's
    // edge cap returns that same size for every anchor a drag can reach), so
    // `transform` is the only per-frame write and the drag stays
    // compositor-only. The position is committed to state once, on drop
    // (handleUp) - that persists the move and triggers PanelCanvas's
    // debounced layout save. During the move phase PanelCanvas never
    // re-renders, so these direct writes are safe from being clobbered by a
    // reconcile.
    let last = { x: panel.anchor.x, y: panel.anchor.y }
    const handleMove = (moveEvent: MouseEvent): void => {
      const el = frameRef.current
      if (!draggingRef.current || !el) return
      last = anchorFromPointer(
        moveEvent.clientX - grabOffsetX,
        moveEvent.clientY - grabOffsetY,
        canvasSize,
        spec.sizes[panel.size]
      )
      const deltaX = ((last.x - panel.anchor.x) / 100) * canvasSize.width
      const deltaY = ((last.y - panel.anchor.y) / 100) * canvasSize.height
      el.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`
    }
    const handleUp = (): void => {
      // A real mouseup and the interactive-change/detach abort are meant to
      // be mutually exclusive, but guard idempotency anyway: a stray second
      // invocation (of either) becomes a clean no-op instead of double-
      // logging drag-perf or double-committing the drop position.
      if (!draggingRef.current) return
      draggingRef.current = false
      endDragRef.current = null
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      const el = frameRef.current
      if (el) {
        // Assert the committed rest position imperatively (matching what
        // `onDrag`'s state update will render) in the same synchronous block
        // as clearing the transform, rather than relying on React flushing
        // that state update before the next paint - true today for a
        // discrete native mouseup handler, but asserting it directly removes
        // the dependency on that timing outright.
        const finalStyle = panelStyle(
          { ...panel.anchor, x: last.x, y: last.y },
          spec.sizes[panel.size],
          canvasSize
        )
        el.style.left = String(finalStyle.left)
        el.style.top = String(finalStyle.top)
        el.style.transform = ''
        el.style.willChange = ''
      }
      document.documentElement.classList.remove(DRAGGING_CLASS)
      window.overlay.setPacketBatchSuspended(false)
      perf.stop()
      onDrag(panel.id, last.x, last.y)
    }

    // Lets the interactive-change/detach effect above end this drag exactly
    // as a mouseup would (same cleanup, commits the last known position).
    endDragRef.current = handleUp

    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
  }

  // A pinned panel stays on screen when the overlay is hidden; everything else
  // is only shown while interactive. When shown-but-not-interactive it must be
  // purely display: pointer-events-none so it can never capture a click or take
  // focus (the window is already setFocusable(false) in that mode).
  const visible = interactive || !!panel.pinned

  return (
    <div
      ref={frameRef}
      data-panel-frame=""
      className={`flex flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-lg backdrop-blur-sm ${
        interactive ? '' : 'pointer-events-none'
      }`}
      style={{
        ...panelStyle(panel.anchor, spec.sizes[panel.size], canvasSize),
        zIndex: panel.zIndex,
        display: visible ? undefined : 'none'
      }}
      onMouseDown={interactive ? () => onBringToTop(panel.id) : undefined}
    >
      <div
        className={`flex shrink-0 items-center justify-between bg-surface px-2 py-1 ${
          interactive ? 'cursor-move' : ''
        }`}
        onMouseDown={interactive ? startDrag : undefined}
      >
        <span className="truncate text-xs font-medium text-fg-muted">{spec.title}</span>
        {interactive ? (
          <div className="ml-2 flex shrink-0 items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              active={panel.pinned}
              className="uppercase"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onTogglePin(panel.id)}
              title={
                panel.pinned
                  ? 'Unpin: hide this panel when the overlay is hidden'
                  : 'Pin: keep this panel visible when the overlay is hidden'
              }
            >
              {panel.pinned ? '★ pin' : 'pin'}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              className="uppercase"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => onCycleSize(panel.id)}
              title="Cycle panel size"
            >
              {panel.size}
            </Button>
            {Settings && (
              <Button
                variant="ghost"
                size="xs"
                active={showSettings}
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => setShowSettings((v) => !v)}
                title={showSettings ? 'Close settings' : 'Panel settings'}
              >
                ⚙
              </Button>
            )}
            {spec.closable && (
              <Button
                variant="ghost"
                size="xs"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={() => onClose(panel.id)}
                title={
                  spec.ephemeral ? 'Close' : 'Close - toggle back on from the RealmShark panel'
                }
              >
                ✕
              </Button>
            )}
          </div>
        ) : (
          panel.pinned && (
            <span className="ml-2 shrink-0 text-2xs text-success/60" title="Pinned">
              ★
            </span>
          )
        )}
      </div>
      {/* Base typography for every panel body lives here (with ConfigWindow's
          root, the only two places it's set) — panels must not re-declare it. */}
      <div className="min-h-0 flex-1 overflow-auto p-2 text-sm text-fg">
        {showSettings && Settings ? (
          <Settings onDone={() => setShowSettings(false)} />
        ) : (
          <Content size={panel.size} />
        )}
      </div>
    </div>
  )
}

export { SIZE_CYCLE }
export default PanelFrame
