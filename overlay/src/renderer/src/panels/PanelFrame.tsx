import { useRef } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import { anchorFromPointer, panelStyle, type SizePx } from './anchor'
import type { PanelSpec } from './registry'

const SIZE_CYCLE: Record<PanelSize, PanelSize> = { sm: 'md', md: 'lg', lg: 'sm' }

interface PanelFrameProps {
  panel: PanelInstance
  spec: PanelSpec
  canvasSize: SizePx
  onDrag: (id: string, x: number, y: number) => void
  onCycleSize: (id: string) => void
  onBringToTop: (id: string) => void
}

function PanelFrame({
  panel,
  spec,
  canvasSize,
  onDrag,
  onCycleSize,
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

  return (
    <div
      ref={frameRef}
      className="flex flex-col overflow-hidden rounded-lg border border-white/10 bg-black/70 shadow-lg backdrop-blur-sm"
      style={{
        ...panelStyle(panel.anchor, spec.sizes[panel.size], canvasSize),
        zIndex: panel.zIndex
      }}
      onMouseDown={() => onBringToTop(panel.id)}
    >
      <div
        className="flex shrink-0 cursor-move items-center justify-between bg-white/5 px-2 py-1"
        onMouseDown={startDrag}
      >
        <span className="truncate text-xs font-medium text-white/70">{spec.title}</span>
        <button
          className="ml-2 shrink-0 rounded px-1 text-[10px] uppercase text-white/40 hover:text-white/80"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => onCycleSize(panel.id)}
          title="Cycle panel size"
        >
          {panel.size}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-2">
        <Content size={panel.size} />
      </div>
    </div>
  )
}

export { SIZE_CYCLE }
export default PanelFrame
