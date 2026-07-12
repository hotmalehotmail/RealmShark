import { useRef } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import { Button } from '../ui/Button'
import { anchorFromPointer, panelStyle, type SizePx } from './anchor'
import type { PanelSpec } from './registry'

const SIZE_CYCLE: Record<PanelSize, PanelSize> = { sm: 'md', md: 'lg', lg: 'sm' }

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

    // Keep the cursor over the same point of the panel it grabbed, instead
    // of snapping the panel's corner to wherever the cursor happens to be.
    const rect = frameRef.current!.getBoundingClientRect()
    const grabOffsetX = e.clientX - rect.left
    const grabOffsetY = e.clientY - rect.top

    const handleMove = (moveEvent: MouseEvent): void => {
      if (!draggingRef.current) return
      const { x, y } = anchorFromPointer(
        moveEvent.clientX - grabOffsetX,
        moveEvent.clientY - grabOffsetY,
        canvasSize
      )
      onDrag(panel.id, x, y)
    }
    const handleUp = (): void => {
      draggingRef.current = false
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
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
