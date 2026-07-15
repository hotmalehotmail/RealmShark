import { ItemInfoProvider } from '../items/ItemInfoProvider'
import { PANEL_REGISTRY } from '../panels/registry'
import { EntityRegistryProvider } from '../sprites/EntityRegistry'
import { SpriteProvider } from '../sprites/SpriteProvider'
import { InteractiveContext } from '../ui/interactiveContext'

interface PanelMountProps {
  type: string
  size: 'sm' | 'md' | 'lg'
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
 */
function PanelMount({ type, size }: PanelMountProps): React.JSX.Element {
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

  return (
    <SpriteProvider>
      <EntityRegistryProvider>
        <ItemInfoProvider>
          <InteractiveContext.Provider value={true}>
            <div
              data-panel-frame=""
              data-panel-type={type}
              data-panel-size={size}
              className="flex flex-col overflow-hidden rounded-lg border border-edge bg-panel shadow-lg backdrop-blur-sm"
              style={{ width, height }}
            >
              <div className="flex shrink-0 items-center justify-between bg-surface px-2 py-1">
                <span className="truncate text-xs font-medium text-fg-muted">{spec.title}</span>
              </div>
              <div
                data-panel-content=""
                className="min-h-0 flex-1 overflow-auto p-2 text-sm text-fg"
              >
                <Content size={size} />
              </div>
            </div>
          </InteractiveContext.Provider>
        </ItemInfoProvider>
      </EntityRegistryProvider>
    </SpriteProvider>
  )
}

export default PanelMount
