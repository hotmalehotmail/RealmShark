import type { NotificationsSettings } from '../../../shared/settings'
import type { AlertKind, AlertPayload, GameEvent, LootDropEvent, RuleSettings, Tier } from './types'

/** The two soulbound "special" bag colors (docs/asset-pipeline.md "BagType") - same pair as `LootTracker.TRACKED_BAG_TYPES`'s default. */
const WHITE_BAG_TYPE = 6
const ORANGE_BAG_TYPE = 8

function isLootDrop(event: GameEvent): event is LootDropEvent {
  return event.type === 'loot-drop'
}

/** "Bow of Covert Havens (4 enchants)" - the shared body format for a payload that reveals item identity. */
function describeItem(event: LootDropEvent): string {
  const name = event.itemName ?? `Item #${event.itemType}`
  if (event.enchantCount <= 0) return name
  return `${name} (${event.enchantCount} enchant${event.enchantCount === 1 ? '' : 's'})`
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

/** Which override tier (if any) supplied `enchantedDrop`'s effective threshold for a drop - "global" means neither a name nor a SlotType override applies, just the catalog-wide `tier`. */
type EnchantedDropThresholdSource = 'item' | 'slotType' | 'global'

/** Most-specific-wins threshold resolution (PRD §3): item name > SlotType category > the global tier. Shared by `enchantedDrop.match` and `matchesSpecificOverride` below, which also needs to know *which* tier fired, not just its value. */
function resolveEnchantedDropThreshold(
  event: LootDropEvent,
  params: EnchantedDropParams
): { threshold: Tier; source: EnchantedDropThresholdSource } {
  const nameKey = event.itemName?.toLowerCase() ?? null
  const itemThreshold = nameKey !== null ? params.itemOverrides[nameKey] : undefined
  if (itemThreshold !== undefined) return { threshold: itemThreshold, source: 'item' }
  const slotThreshold = params.slotTypeOverrides[event.slotType]
  if (slotThreshold !== undefined) return { threshold: slotThreshold, source: 'slotType' }
  return { threshold: params.tier, source: 'global' }
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
    const { threshold } = resolveEnchantedDropThreshold(event, params)
    if (event.enchantCount < threshold) return null
    return { title: 'Enchanted drop!', body: describeItem(event), icon: event.itemType }
  }
}

/**
 * True iff `event` fires `enchantedDrop` *specifically* because of an
 * item-name or SlotType-category override - not just the global tier (soak
 * #234). `whiteBag`/`orangeBag` use this to decide whether to reveal the
 * item's identity: the user configured that override for a particular
 * item/class, so hiding it there would defeat the point, whereas the global
 * tier says nothing item-specific. Returns `false` if `enchantedDrop` itself
 * is disabled, so a user who turned it off entirely never gets a spoiler via
 * this path either.
 */
function matchesSpecificOverride(event: LootDropEvent, settings: NotificationsSettings): boolean {
  const rule = resolveRuleSettings(enchantedDrop, settings)
  if (!rule.enabled) return false
  const params = rule.params as unknown as EnchantedDropParams
  const { threshold, source } = resolveEnchantedDropThreshold(event, params)
  return source !== 'global' && event.enchantCount >= threshold
}

/**
 * Shared `whiteBag`/`orangeBag` payload (soak #234 - "loot bag notifications
 * should not spoil what the item is"): generic body, and the bag's own icon
 * (`event.bagIcon`) rather than the item's - a bag glimpsed from across the
 * room shouldn't leak its contents. Reveals the real item (name, enchant
 * count, its own icon) only when `matchesSpecificOverride` says the drop also
 * fired `enchantedDrop` via an item/class override the user explicitly
 * configured.
 */
function lootBagPayload(
  title: string,
  event: LootDropEvent,
  settings: NotificationsSettings
): AlertPayload {
  if (matchesSpecificOverride(event, settings)) {
    return { title, body: describeItem(event), icon: event.itemType }
  }
  return { title, body: 'A new bag has dropped.', icon: event.bagIcon ?? undefined }
}

export const whiteBag: AlertKind = {
  id: 'whiteBag',
  title: 'White Bag',
  eventType: 'loot-drop',
  defaults: { enabled: true, banner: true, sound: true, params: {} },
  match: (event, _params, settings) => {
    if (!isLootDrop(event) || event.bagType !== WHITE_BAG_TYPE) return null
    return lootBagPayload('White bag!', event, settings)
  }
}

export const orangeBag: AlertKind = {
  id: 'orangeBag',
  title: 'Orange Bag',
  eventType: 'loot-drop',
  defaults: { enabled: true, banner: true, sound: true, params: {} },
  match: (event, _params, settings) => {
    if (!isLootDrop(event) || event.bagType !== ORANGE_BAG_TYPE) return null
    return lootBagPayload('Orange bag!', event, settings)
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
