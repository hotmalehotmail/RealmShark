import type { FiredAlertStore } from '../alerts/store'

/**
 * Four representative banner-worthy fired alerts (issue #219's
 * `AlertToastGalleryMount`, reused by issue #220's `PanelMount` for the
 * `notifications` panel type) - no packet replay needed, since both
 * `AlertToastHost` and `NotificationsPanel` only ever read a
 * `FiredAlertStore`'s public API (PRD §1 layering contract). The whiteBag/
 * orangeBag payloads mirror `catalog.ts`'s `lootBagPayload` default (soak
 * #234 - generic body, the bag's own icon, no item identity) rather than
 * hand-picking an item name, so this gallery stays representative of what
 * actually fires live.
 */
export function seedGallery(store: FiredAlertStore): void {
  store.append(
    { title: 'White bag!', body: 'A new bag has dropped.', icon: 6 },
    ['whiteBag'],
    1000,
    true,
    true
  )
  store.append(
    { title: 'Orange bag!', body: 'A new bag has dropped.', icon: 8 },
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
