import { useEffect, useRef, useState } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import type { SizePx } from './anchor'
import { isPersistablePanel, mergeWithDefaults } from './panelLayout'
import { PanelSpawnContext } from './panelSpawn'
import PanelFrame, { SIZE_CYCLE } from './PanelFrame'
import { PANEL_REGISTRY } from './registry'

const SAVE_DEBOUNCE_MS = 500

/** Default anchor a programmatically-spawned panel (`usePanelSpawn().openPanel`) appears at. */
const SPAWN_ANCHOR = { pos: 'tl' as const, x: 15, y: 12 }

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

  // See panelSpawn.ts's doc comment - lets a panel body (e.g. DpsSummaryPanel)
  // open/close another panel on this same canvas without PanelCanvas needing
  // to know anything about that panel's purpose.
  const openPanel = (id: string, type: string, size: PanelSize = 'lg'): void => {
    setPanels((prev) => {
      const maxZ = Math.max(0, ...prev.map((p) => p.zIndex))
      if (prev.some((p) => p.id === id)) {
        return prev.map((p) => (p.id === id && p.zIndex !== maxZ ? { ...p, zIndex: maxZ + 1 } : p))
      }
      return [...prev, { id, type, anchor: SPAWN_ANCHOR, size, zIndex: maxZ + 1 }]
    })
  }

  const closePanel = (id: string): void => {
    setPanels((prev) => prev.filter((p) => p.id !== id))
  }

  const isOpen = (id: string): boolean => panels.some((p) => p.id === id)

  return (
    <PanelSpawnContext.Provider value={{ openPanel, closePanel, isOpen }}>
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
              onClose={closePanel}
            />
          )
        })}
      </div>
    </PanelSpawnContext.Provider>
  )
}

export default PanelCanvas
