import type { NotificationsSettings } from '../../../shared/settings'
import type { AlertKind, GameEvent, LootDropEvent, RuleSettings, Tier } from './types'

/** The two soulbound "special" bag colors (docs/asset-pipeline.md "BagType") - same pair as `LootTracker.TRACKED_BAG_TYPES`'s default. */
const WHITE_BAG_TYPE = 6
const ORANGE_BAG_TYPE = 8

function isLootDrop(event: GameEvent): event is LootDropEvent {
  return event.type === 'loot-drop'
}

/** "Bow of Covert Havens (4 enchants)" - the shared body format for every loot-drop payload. */
function describeItem(event: LootDropEvent): string {
  const name = event.itemName ?? `Item #${event.itemType}`
  if (event.enchantCount <= 0) return name
  return `${name} (${event.enchantCount} enchant${event.enchantCount === 1 ? '' : 's'})`
}

export const whiteBag: AlertKind = {
  id: 'whiteBag',
  title: 'White Bag',
  eventType: 'loot-drop',
  defaults: { enabled: true, banner: true, sound: true, params: {} },
  match: (event) => {
    if (!isLootDrop(event) || event.bagType !== WHITE_BAG_TYPE) return null
    return { title: 'White bag!', body: describeItem(event), icon: event.itemType }
  }
}

export const orangeBag: AlertKind = {
  id: 'orangeBag',
  title: 'Orange Bag',
  eventType: 'loot-drop',
  defaults: { enabled: true, banner: true, sound: true, params: {} },
  match: (event) => {
    if (!isLootDrop(event) || event.bagType !== ORANGE_BAG_TYPE) return null
    return { title: 'Orange bag!', body: describeItem(event), icon: event.itemType }
  }
}

/** `enchantedDrop`'s params shape (PRD §3 "enchantedDrop threshold resolution"). */
export interface EnchantedDropParams {
  /** Global fallback threshold. */
  tier: Tier
  /** SlotType id -> lowered threshold (docs/notifications.md "SlotType names" / `slotTypeNames.ts`). */
  slotTypeOverrides: Record<number, Tier>
  /** Item display name (lowercased) -> lowered threshold. */
  itemOverrides: Record<string, Tier>
}

const DEFAULT_ENCHANTED_DROP_PARAMS: EnchantedDropParams = {
  tier: 4,
  slotTypeOverrides: {},
  itemOverrides: {}
}

export const enchantedDrop: AlertKind = {
  id: 'enchantedDrop',
  title: 'Enchanted Drop',
  eventType: 'loot-drop',
  defaults: {
    enabled: true,
    banner: true,
    sound: true,
    params: DEFAULT_ENCHANTED_DROP_PARAMS as unknown as Record<string, unknown>
  },
  match: (event, rawParams) => {
    if (!isLootDrop(event)) return null
    const params = rawParams as unknown as EnchantedDropParams
    const nameKey = event.itemName?.toLowerCase() ?? null
    // Most specific wins (PRD §3): item name > SlotType category > the global tier.
    const effective =
      (nameKey !== null ? params.itemOverrides[nameKey] : undefined) ??
      params.slotTypeOverrides[event.slotType] ??
      params.tier
    if (event.enchantCount < effective) return null
    return { title: 'Enchanted drop!', body: describeItem(event), icon: event.itemType }
  }
}

/**
 * Catalog order is the documented banner-priority order (PRD §3 "Multi-match
 * semantics"): when one event matches several enabled rules and more than
 * one wants a banner, the dispatcher (`dispatcher.ts`) shows the payload
 * from the FIRST banner-wanting entry in this array's order. whiteBag/
 * orangeBag precede enchantedDrop so a divine white/orange bag reads as its
 * bag-color banner first - the enchant fact still reaches the user via the
 * fired alert's full `matchedKindIds` (history, issue #220).
 *
 * Adding a new notification (PRD §1) is exactly one more entry here - the
 * dispatcher and store need zero changes (proved by
 * `test/alerts-engine.test.ts`'s extensibility test).
 */
export const CATALOG: readonly AlertKind[] = [whiteBag, orangeBag, enchantedDrop]

/**
 * Resolves one catalog kind's effective settings for the current event,
 * merging the user's `OverlaySettings.notifications.rules[kind.id]` (if any)
 * onto that kind's own `defaults` field-by-field - a missing `rules` entry
 * entirely, or a present entry missing individual fields (including
 * individual `params` keys), falls back to the catalog default rather than
 * to `undefined`. A `rules` entry for a kind id no longer in the catalog is
 * simply never read (nothing iterates `settings.rules` directly).
 */
export function resolveRuleSettings(
  kind: AlertKind,
  settings: NotificationsSettings
): RuleSettings {
  const raw = settings.rules[kind.id]
  return {
    enabled: raw?.enabled ?? kind.defaults.enabled,
    banner: raw?.banner ?? kind.defaults.banner,
    sound: raw?.sound ?? kind.defaults.sound,
    params: { ...kind.defaults.params, ...(raw?.params ?? {}) }
  }
}
