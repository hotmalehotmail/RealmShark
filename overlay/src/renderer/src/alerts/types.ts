import type { NotificationsSettings } from '../../../shared/settings'

/**
 * v1 event vocabulary the rule catalog matches against (PRD §2,
 * docs/prd-notifications.md).
 */
export interface LootDropEvent {
  type: 'loot-drop'
  itemType: number
  itemName: string | null
  bagType: number
  slotType: number
  enchantCount: number
  enchantCode: string
  /**
   * The dropped bag's own ground-bag entity objectType (`LootTracker.bagIcon`
   * - null if unresolved, e.g. before the `lootBagTypes` envelope first
   * arrives), independent of `itemType`. `whiteBag`/`orangeBag` (`catalog.ts`)
   * show this instead of the item's own icon by default (soak #234 - "loot
   * bag notifications should not spoil what the item is").
   */
  bagIcon: number | null
}

/**
 * A chat message (issue #222, phase 2 - PRD §2/§6). Only `TextPacket`
 * traffic reaches this detector (see `AlertEngine.ts`'s `onChatMessage`) -
 * `channel` classifies the wire-verified shapes pinned via the Status
 * panel's chat-probe diagnostic (`docs/overlay-main-process.md` "Chat
 * probe", 2026-07-18): `'party'` for `recipient === '*Party*'` (the exact
 * literal sentinel, asterisks included - party senders arrive with
 * `objectId: -1`, so `AlertEngine` resolves the local-player self-ignore
 * check by name, never by objectId), `'local'` for `recipient === ''`
 * (local/world chat, sender's live entity id). Guild/`/tell` sentinels were
 * not sampled (out of scope, PRD §6) - anything else classifies as
 * `'unknown'` rather than guessing, so a future guild/PM rule doesn't
 * silently misfire against an unverified shape.
 */
export interface ChatEvent {
  type: 'chat'
  sender: string
  /** The uncensored message - keyword matching (`partyChat`) runs on this, never `cleanText` (PRD §2). */
  text: string
  /** Profanity-filtered variant of `text` (`TextPacket.cleanText`) - display-only, never matched against. */
  cleanText: string
  numStars: number
  channel: 'party' | 'local' | 'unknown'
}

export type GameEvent = LootDropEvent | ChatEvent

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
  /**
   * Pure. `settings` is the full live `NotificationsSettings` (not just this
   * kind's own resolved `params`) - most rules never touch it, but a rule can
   * consult another kind's resolved settings to change its own payload (soak
   * #234: `whiteBag`/`orangeBag` check whether `enchantedDrop` also matched
   * via a specific item/class override before deciding whether to reveal the
   * item's identity).
   */
  match: (
    event: GameEvent,
    params: Record<string, unknown>,
    settings: NotificationsSettings
  ) => AlertPayload | null
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
