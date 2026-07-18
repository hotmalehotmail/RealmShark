/**
 * v1 event vocabulary the rule catalog matches against (PRD §2,
 * docs/prd-notifications.md). Chat is deliberately out of scope for issue
 * #218 (phase 2, issue #222 per the PRD's §9 phasing) - this union stays
 * loot-only until the party-channel wire shape is verified (§6).
 */
export interface LootDropEvent {
  type: 'loot-drop'
  itemType: number
  itemName: string | null
  bagType: number
  slotType: number
  enchantCount: number
  enchantCode: string
}

export type GameEvent = LootDropEvent

/** A fired alert's user-visible content (PRD §3). */
export interface AlertPayload {
  title: string
  body: string
  icon?: number
}

/** A single catalog kind's settings after merging user overrides onto its own defaults - see `catalog.ts`'s `resolveRuleSettings`. */
export interface RuleSettings {
  enabled: boolean
  banner: boolean
  sound: boolean
  params: Record<string, unknown>
}

/** Rarity tier numbers (`sprites/enchantRarity.ts`'s filled-enchant-count scale): 1 = uncommon, 2 = rare, 3 = legendary, 4 = divine. */
export type Tier = 1 | 2 | 3 | 4

/**
 * One rule in the catalog (PRD §3, `catalog.ts`). Pure and React-free (the
 * PRD §1 layering contract) - `match` is a pure function of the event and
 * its resolved params, returning the banner/history payload if the rule
 * fires, else `null`. `params` is loosely typed here (the shape is
 * catalog-entry-specific, e.g. `enchantedDrop`'s `EnchantedDropParams`) so
 * `AlertKind` itself stays non-generic and the built-in kinds can live
 * together in one `CATALOG` array without variance gymnastics - each
 * `match` implementation casts to its own params shape internally, the same
 * pattern this codebase already uses for wire-data envelopes.
 */
export interface AlertKind {
  /** Stable settings key - the record key under `OverlaySettings.notifications.rules`. */
  id: string
  /** Shown in the settings UI (issue #221) and the history panel (issue #220). */
  title: string
  eventType: GameEvent['type']
  defaults: RuleSettings
  /** Minimum ms between two dispatched fires of this kind (PRD §7 "Spam"); omit for no cooldown - none of the v1 loot rules have one. */
  cooldownMs?: number
  match: (event: GameEvent, params: Record<string, unknown>) => AlertPayload | null
}

/** One entry in the fired-alert session log (`store.ts`). */
export interface FiredAlert {
  id: string
  time: number
  /** The displayed payload (PRD §3 point 2/4) - the first banner-wanting match's payload, or the first survivor's if none wanted a banner. */
  payload: AlertPayload
  /** Every catalog kind id that matched this event, not just the one whose payload is shown (PRD §3 point 4). */
  matchedKindIds: string[]
  /**
   * Whether a surviving match wanted the banner channel for this alert
   * (`DispatchResult.banner !== null` - `dispatcher.ts`). `AlertToastHost`
   * (issue #219) reads this to decide which history entries also pop a
   * banner, rather than banner-ing every fired alert.
   */
  banner: boolean
  /** Whether a surviving match wanted the sound channel (`DispatchResult.sound`) - `AlertToastHost` reads this to decide whether to play the ping. */
  sound: boolean
}
