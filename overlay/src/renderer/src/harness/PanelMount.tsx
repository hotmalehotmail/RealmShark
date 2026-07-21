import { useEffect, useState } from 'react'
import { AlertStoreContext } from '../alerts/alertStoreContext'
import { FiredAlertStore } from '../alerts/store'
import { DpsDetailSelectionProvider } from '../dps/DpsDetailSelectionProvider'
import { DpsFeedProvider } from '../dps/DpsFeedProvider'
import { useDpsDetailSelection } from '../dps/dpsDetailContext'
import { useDpsHistory } from '../dps/useDpsHistory'
import { ItemInfoProvider } from '../items/ItemInfoProvider'
import { PanelSpawnContext } from '../panels/panelSpawn'
import { PANEL_REGISTRY } from '../panels/registry'
import { EntityRegistryProvider } from '../sprites/EntityRegistry'
import { SpriteProvider } from '../sprites/SpriteProvider'
import { InteractiveContext } from '../ui/interactiveContext'
import { seedGallery } from './alertGallerySeed'

interface PanelMountProps {
  type: string
  size: 'sm' | 'md' | 'lg'
  /** Render the panel type's settings view (issue #221's `PanelSpec.settings`) instead of its normal content, when one is registered. Ignored otherwise. */
  settings?: boolean
}

/**
 * `usePanelSpawn()` and `useDpsDetailSelection()` require a real provider
 * (they throw otherwise, by design - see their doc comments), but this
 * single-panel harness mount has no `PanelCanvas` to supply one. A no-op
 * spawn API is enough for a static shot (nothing here simulates a click).
 */
const NOOP_PANEL_SPAWN = {
  openPanel: (): void => {},
  closePanel: (): void => {},
  isOpen: (): boolean => false
}

/**
 * Only for the `dpsDetail` shot: that panel renders nothing until a session
 * is selected, which normally only happens via a `DpsSummaryPanel` row
 * click - unsimulated here. Auto-selects the first retained history entry
 * once the `gallery` fixture has produced one, so `npm run shots` captures
 * real per-enemy/per-player content instead of the empty-selection state.
 */
function AutoSelectFirstDpsSession(): null {
  const history = useDpsHistory()
  const { selected, select } = useDpsDetailSelection()
  useEffect(() => {
    if (!selected && history.length > 0) select(history[0])
  }, [history, selected, select])
  return null
}

/**
 * Mounts exactly one registered panel at its preset pixel dimensions, with
 * the same chrome (title bar) `PanelFrame` renders - the `?panel=<type>&size=
 * <sm|md|lg>` harness mount mode (PRD §5.2), the unit `npm run shots`
 * screenshots. Static (no drag/pin/resize affordances - those are
 * `PanelCanvas`/`PanelFrame` concerns, irrelevant to a single frozen shot),
 * but wrapped in the same providers `App.tsx` uses so every panel's data
 * hooks (`useEntityRegistry`, `useSprites`, `useItemInfo`) resolve exactly as
 * they do in the full canvas. The scrollable content wrapper carries
 * `data-panel-content` so `e2e/shots.spec.ts` can measure `scrollHeight` vs
 * `clientHeight` to detect below-the-fold clipping and, when present,
 * re-render it at its natural height for the `-full` variant shot.
 * <p>
 * `&settings=1` (issue #221) renders the panel type's registered settings
 * view (`PanelSpec.settings`) in place of `component`, mirroring what
 * `PanelFrame`'s gear flip does live - a no-op `onDone` since there's no
 * "flip back" affordance to click in a static single-view shot.
 */
function PanelMount({ type, size, settings }: PanelMountProps): React.JSX.Element {
  // Only the `notifications` shot needs seeded alert data; every other panel
  // type gets an empty, harmless store - same unconditional-but-idle
  // provider pattern this mount already uses for Sprite/EntityRegistry/
  // ItemInfo. Hooks must run before the unknown-type early return below.
  const [alertStore] = useState(() => {
    const store = new FiredAlertStore()
    if (type === 'notifications') seedGallery(store)
    return store
  })

  const spec = PANEL_REGISTRY[type]
  if (!spec) {
    return (
      <div style={{ padding: 8, color: 'red', fontFamily: 'monospace' }}>
        Unknown panel type &quot;{type}&quot;. Known types: {Object.keys(PANEL_REGISTRY).join(', ')}
      </div>
    )
  }
  const { width, height } = spec.sizes[size]
  const Content = spec.component
  const Settings = settings ? spec.settings : undefined

  return (
    <SpriteProvider>
      <EntityRegistryProvider>
        <ItemInfoProvider>
          <AlertStoreContext.Provider value={alertStore}>
            <DpsFeedProvider>
              <DpsDetailSelectionProvider>
                <PanelSpawnContext.Provider value={NOOP_PANEL_SPAWN}>
                  <InteractiveContext.Provider value={true}>
                    {type === 'dpsDetail' && <AutoSelectFirstDpsSession />}
                    <div
                      data-panel-frame=""
                      data-panel-type={type}
                      data-panel-size={size}
                      className="flex flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-lg backdrop-blur-sm"
                      style={{ width, height }}
                    >
                      <div className="flex shrink-0 items-center justify-between bg-surface px-2 py-1">
                        <span className="truncate text-xs font-medium text-fg-muted">
                          {spec.title}
                          {Settings ? ' settings' : ''}
                        </span>
                      </div>
                      <div
                        data-panel-content=""
                        className="min-h-0 flex-1 overflow-auto p-2 text-sm text-fg"
                      >
                        {Settings ? <Settings onDone={() => {}} /> : <Content size={size} />}
                      </div>
                    </div>
                  </InteractiveContext.Provider>
                </PanelSpawnContext.Provider>
              </DpsDetailSelectionProvider>
            </DpsFeedProvider>
          </AlertStoreContext.Provider>
        </ItemInfoProvider>
      </EntityRegistryProvider>
    </SpriteProvider>
  )
}

export default PanelMount
