import { useRef } from 'react'
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
}

function PanelFrame({
  panel,
  spec,
  canvasSize,
  interactive,
  onDrag,
  onCycleSize,
  onTogglePin,
  onBringToTop
}: PanelFrameProps): React.JSX.Element {
  const Content = spec.component
  const draggingRef = useRef(false)
  const frameRef = useRef<HTMLDivElement>(null)

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
    // `top` stay at their rest values for the whole drag; only `transform`
    // (position) and, when a clamped edge actually changes them, `width`/
    // `height` are written per frame. The position is committed to state
    // once, on drop (handleUp) - that persists the move and triggers
    // PanelCanvas's debounced layout save. During the move phase PanelCanvas
    // never re-renders, so these direct writes are safe from being clobbered
    // by a reconcile.
    let last = { x: panel.anchor.x, y: panel.anchor.y }
    let lastWidth: string | undefined
    let lastHeight: string | undefined
    const handleMove = (moveEvent: MouseEvent): void => {
      const el = frameRef.current
      if (!draggingRef.current || !el) return
      last = anchorFromPointer(
        moveEvent.clientX - grabOffsetX,
        moveEvent.clientY - grabOffsetY,
        canvasSize
      )
      const s = panelStyle(
        { ...panel.anchor, x: last.x, y: last.y },
        spec.sizes[panel.size],
        canvasSize
      )
      // panelStyle's declared type is CSSProperties (string | number for
      // width/height, even though it only ever returns numbers) - narrow
      // rather than assert, so a future string/percentage return can't
      // silently turn into `NaNpx`.
      const width = typeof s.width === 'number' ? `${s.width}px` : String(s.width ?? '')
      const height = typeof s.height === 'number' ? `${s.height}px` : String(s.height ?? '')
      if (width !== lastWidth) {
        el.style.width = width
        lastWidth = width
      }
      if (height !== lastHeight) {
        el.style.height = height
        lastHeight = height
      }
      const deltaX = ((last.x - panel.anchor.x) / 100) * canvasSize.width
      const deltaY = ((last.y - panel.anchor.y) / 100) * canvasSize.height
      el.style.transform = `translate3d(${deltaX}px, ${deltaY}px, 0)`
    }
    const handleUp = (): void => {
      draggingRef.current = false
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
      const el = frameRef.current
      if (el) {
        el.style.transform = ''
        el.style.willChange = ''
      }
      document.documentElement.classList.remove(DRAGGING_CLASS)
      window.overlay.setPacketBatchSuspended(false)
      perf.stop()
      onDrag(panel.id, last.x, last.y)
    }

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
        <Content size={panel.size} />
      </div>
    </div>
  )
}

export { SIZE_CYCLE }
export default PanelFrame
