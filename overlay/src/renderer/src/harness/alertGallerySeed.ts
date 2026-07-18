import type { FiredAlertStore } from '../alerts/store'

/**
 * Four representative banner-worthy fired alerts (issue #219's
 * `AlertToastGalleryMount`, reused by issue #220's `PanelMount` for the
 * `notifications` panel type) - no packet replay needed, since both
 * `AlertToastHost` and `NotificationsPanel` only ever read a
 * `FiredAlertStore`'s public API (PRD §1 layering contract).
 */
export function seedGallery(store: FiredAlertStore): void {
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
