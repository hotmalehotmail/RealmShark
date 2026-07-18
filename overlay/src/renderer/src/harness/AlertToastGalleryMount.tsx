import { useEffect, useState } from 'react'
import { AlertToastHost } from '../alerts/AlertToastHost'
import { FiredAlertStore } from '../alerts/store'
import { ItemInfoProvider } from '../items/ItemInfoProvider'
import { EntityRegistryProvider } from '../sprites/EntityRegistry'
import { SpriteProvider } from '../sprites/SpriteProvider'
import { seedGallery } from './alertGallerySeed'

/**
 * Representative toast stack for `npm run shots` (issue #219 acceptance
 * criteria: "A representative toast stack is added to the committed panel
 * gallery"). `AlertToastHost` isn't a `PANEL_REGISTRY` entry (it's an
 * App-level singleton, not a draggable/resizable panel - PRD §4), so it
 * gets its own harness mount mode (`?toastGallery=1`) instead of going
 * through `PanelMount`.
 * <p>
 * Seeds a `FiredAlertStore` directly via `alertGallerySeed.ts`'s
 * `seedGallery` (no packet replay needed - the store's public API is all
 * `AlertToastHost` ever reads; issue #220's `PanelMount` reuses the same
 * seed for the `notifications` panel type), appended in a `useEffect` that
 * runs strictly AFTER `AlertToastHost`'s own mount-time subscription (child
 * effects fire before parent effects) - appending them any earlier (e.g.
 * before first render) would make `AlertToastHost` treat them as
 * pre-existing history instead of freshly-fired alerts (its "seed
 * `seenIds` from whatever's already in the store at mount" guard, meant for
 * a real remount) and render nothing.
 */
export function AlertToastGalleryMount(): React.JSX.Element {
  const [store] = useState(() => new FiredAlertStore())

  useEffect(() => {
    seedGallery(store)
    // StrictMode's dev-only double-invoke runs this effect, tears it down,
    // then runs it again on the SAME store instance (state isn't
    // re-initialized, only effects re-fire) - undoing the seed here is what
    // keeps the final mount at exactly 4 alerts instead of 8.
    return () => store.reset()
  }, [store])

  return (
    <SpriteProvider>
      <EntityRegistryProvider>
        <ItemInfoProvider>
          <div
            data-toast-gallery=""
            className="relative"
            style={{ width: 340, height: 320, background: 'transparent' }}
          >
            <AlertToastHost store={store} interactive={false} volume={1} />
          </div>
        </ItemInfoProvider>
      </EntityRegistryProvider>
    </SpriteProvider>
  )
}
