import { useEffect, useRef, useState } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import type { SizePx } from './anchor'
import {
  isPanelOpen,
  isPersistablePanel,
  mergeWithDefaults,
  withPanelClosed,
  withPanelOpen
} from './panelLayout'
import { PanelSpawnContext } from './panelSpawn'
import PanelFrame, { SIZE_CYCLE } from './PanelFrame'
import { PANEL_REGISTRY } from './registry'

const SAVE_DEBOUNCE_MS = 500

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
      setPanels(mergeWithDefaults(saved?.filter(isPersistablePanel)))
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
      window.overlay.savePanelLayout(panels.filter(isPersistablePanel))
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

  // See panelSpawn.ts's doc comment - lets a panel body (e.g. DpsSummaryPanel
  // or the Status panel's toggle list) open/close another panel on this same
  // canvas without PanelCanvas needing to know anything about that panel's
  // purpose. The actual state transitions are pure functions in
  // panelLayout.ts - see their doc comments for the hide-vs-remove split.
  const openPanel = (id: string, type: string, size: PanelSize = 'lg'): void => {
    setPanels((prev) => withPanelOpen(prev, id, type, size))
  }

  const closePanel = (id: string): void => {
    setPanels((prev) => withPanelClosed(prev, id))
  }

  const isOpen = (id: string): boolean => isPanelOpen(panels, id)

  return (
    <PanelSpawnContext.Provider value={{ openPanel, closePanel, isOpen }}>
      <div className="relative h-full w-full">
        {panels.map((panel) => {
          const spec = PANEL_REGISTRY[panel.type]
          if (!spec || panel.hidden) return null
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
              onClose={closePanel}
            />
          )
        })}
      </div>
    </PanelSpawnContext.Provider>
  )
}

export default PanelCanvas
