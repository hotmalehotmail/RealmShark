import { useEffect, useRef, useState } from 'react'
import type { PanelInstance, PanelSize } from '../../../shared/panels'
import type { SizePx } from './anchor'
import { PanelSpawnContext } from './panelSpawn'
import PanelFrame, { SIZE_CYCLE } from './PanelFrame'
import { PANEL_REGISTRY } from './registry'

const SAVE_DEBOUNCE_MS = 500

/** Default anchor a programmatically-spawned panel (`usePanelSpawn().openPanel`) appears at. */
const SPAWN_ANCHOR = { pos: 'tl' as const, x: 15, y: 12 }

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
    },
    {
      id: 'loot',
      type: 'loot',
      anchor: { pos: 'tl', x: 35, y: 75 },
      size: 'md',
      zIndex: 7
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

// A `closable` (programmatically-spawned) panel's selection lives in a
// non-persisted context (e.g. dpsDetailContext.ts), so persisting the panel
// instance itself would restore an empty shell on next launch with no way to
// restore what it was showing. Exclude such panels both when saving (so they
// never reach panels.json) and when loading (so a panels.json written before
// this fix - or by an older build - doesn't resurrect a stray empty one).
function isPersistablePanel(panel: PanelInstance): boolean {
  return !PANEL_REGISTRY[panel.type]?.closable
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

  return (
    <PanelSpawnContext.Provider value={{ openPanel, closePanel }}>
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
