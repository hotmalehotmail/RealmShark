import { useEffect, useState } from 'react'
import { AlertToastHost } from '../alerts/AlertToastHost'
import { FiredAlertStore } from '../alerts/store'
import { ItemInfoProvider } from '../items/ItemInfoProvider'
import { EntityRegistryProvider } from '../sprites/EntityRegistry'
import { SpriteProvider } from '../sprites/SpriteProvider'

/**
 * Representative toast stack for `npm run shots` (issue #219 acceptance
 * criteria: "A representative toast stack is added to the committed panel
 * gallery"). `AlertToastHost` isn't a `PANEL_REGISTRY` entry (it's an
 * App-level singleton, not a draggable/resizable panel - PRD §4), so it
 * gets its own harness mount mode (`?toastGallery=1`) instead of going
 * through `PanelMount`.
 * <p>
 * Seeds a `FiredAlertStore` directly (no packet replay needed - the store's
 * public API is all `AlertToastHost` ever reads) with four banner-worthy
 * fired alerts, appended in a `useEffect` that runs strictly AFTER
 * `AlertToastHost`'s own mount-time subscription (child effects fire before
 * parent effects) - appending them any earlier (e.g. before first render)
 * would make `AlertToastHost` treat them as pre-existing history instead of
 * freshly-fired alerts (its "seed `seenIds` from whatever's already in the
 * store at mount" guard, meant for a real remount) and render nothing.
 */
function seedGallery(store: FiredAlertStore): void {
  store.append(
    { title: 'White bag!', body: 'Potion of Life', icon: 1001 },
    ['whiteBag'],
    1000,
    true,
    true
  )
  store.append(
    { title: 'Orange bag!', body: 'Scroll of Protection', icon: 1050 },
    ['orangeBag'],
    2000,
    true,
    true
  )
  store.append(
    { title: 'Enchanted drop!', body: 'Doom Bow (4 enchants)', icon: 1210 },
    ['enchantedDrop'],
    3000,
    true,
    true
  )
  store.append(
    { title: 'Enchanted drop!', body: 'Ogmur (4 enchants)', icon: 1211 },
    ['enchantedDrop'],
    4000,
    true,
    true
  )
}

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
