import { useEffect, useRef, useState } from 'react'
import type { PanelInstance } from '../../../shared/panels'
import type { SizePx } from './anchor'
import PanelFrame, { SIZE_CYCLE } from './PanelFrame'
import { PANEL_REGISTRY } from './registry'

const SAVE_DEBOUNCE_MS = 500

// Positions are chosen so the default 'md'-size panels don't overlap: status
// sits top-left, dps below it with enough vertical clearance, and console
// off to the side entirely - see registry.ts for the md dimensions this
// assumes.
function defaultLayout(): PanelInstance[] {
  return [
    { id: 'status', type: 'status', anchor: { pos: 'tl', x: 2, y: 2 }, size: 'md', zIndex: 1 },
    { id: 'dps', type: 'dps', anchor: { pos: 'tl', x: 2, y: 30 }, size: 'md', zIndex: 2 },
    { id: 'console', type: 'console', anchor: { pos: 'tl', x: 35, y: 2 }, size: 'md', zIndex: 3 },
    {
      id: 'character',
      type: 'character',
      anchor: { pos: 'tl', x: 35, y: 50 },
      size: 'md',
      zIndex: 4
    },
    {
      id: 'instance',
      type: 'instance',
      anchor: { pos: 'tl', x: 65, y: 2 },
      size: 'md',
      zIndex: 5
    },
    {
      id: 'dpsSummary',
      type: 'dpsSummary',
      anchor: { pos: 'tl', x: 65, y: 40 },
      size: 'md',
      zIndex: 6
    }
  ]
}

// A saved layout is authoritative for the panels it contains (user moved/
// resized them), but panel types added in a later version won't be in an
// older panels.json. Without this, a newly-added default panel (e.g. the
// console) would never appear for existing users on upgrade - only on a
// fresh install or after clearing panels.json. So we keep every saved panel
// and append any default panel whose id isn't present yet.
function mergeWithDefaults(saved: PanelInstance[] | null | undefined): PanelInstance[] {
  const defaults = defaultLayout()
  if (!saved || saved.length === 0) return defaults
  const savedIds = new Set(saved.map((p) => p.id))
  const missing = defaults.filter((p) => !savedIds.has(p.id))
  return missing.length > 0 ? [...saved, ...missing] : saved
}

function windowSize(): SizePx {
  return { width: window.innerWidth, height: window.innerHeight }
}

interface PanelCanvasProps {
  interactive: boolean
}

function PanelCanvas({ interactive }: PanelCanvasProps): React.JSX.Element {
  const [panels, setPanels] = useState<PanelInstance[]>([])
  const [canvasSize, setCanvasSize] = useState<SizePx>(windowSize)
  const loadedRef = useRef(false)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    window.overlay.getPanelLayout().then((saved) => {
      setPanels(mergeWithDefaults(saved))
      loadedRef.current = true
    })

    const handleResize = (): void => setCanvasSize(windowSize())
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  useEffect(() => {
    // Skip saving the very first render (before the initial load resolves),
    // so we never overwrite a saved layout with the pre-load empty array.
    if (!loadedRef.current) return
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      window.overlay.savePanelLayout(panels)
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(saveTimer.current)
  }, [panels])

  const updatePanel = (id: string, patch: Partial<PanelInstance>): void => {
    setPanels((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }

  const bringToTop = (id: string): void => {
    setPanels((prev) => {
      const maxZ = Math.max(0, ...prev.map((p) => p.zIndex))
      return prev.map((p) => (p.id === id && p.zIndex !== maxZ ? { ...p, zIndex: maxZ + 1 } : p))
    })
  }

  return (
    <div className="relative h-full w-full">
      {panels.map((panel) => {
        const spec = PANEL_REGISTRY[panel.type]
        if (!spec) return null
        return (
          <PanelFrame
            key={panel.id}
            panel={panel}
            spec={spec}
            canvasSize={canvasSize}
            interactive={interactive}
            onDrag={(id, x, y) => updatePanel(id, { anchor: { pos: 'tl', x, y } })}
            onCycleSize={(id) => {
              const current = panels.find((p) => p.id === id)
              if (current) updatePanel(id, { size: SIZE_CYCLE[current.size] })
            }}
            onTogglePin={(id) => {
              const current = panels.find((p) => p.id === id)
              if (current) updatePanel(id, { pinned: !current.pinned })
            }}
            onBringToTop={bringToTop}
          />
        )
      })}
    </div>
  )
}

export default PanelCanvas
