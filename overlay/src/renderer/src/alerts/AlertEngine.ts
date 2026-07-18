import type { PacketEnvelope } from '../../../shared/ipc'
import type { NotificationsSettings } from '../../../shared/settings'
import {
  CONSUMED_ENVELOPE_TYPES as LOOT_CONSUMED_ENVELOPE_TYPES,
  LootTracker,
  type LootEntry
} from '../loot/LootTracker'
import { CATALOG } from './catalog'
import { dispatchEvent } from './dispatcher'
import { FiredAlertStore } from './store'
import type { AlertKind, LootDropEvent } from './types'

/**
 * Every BagType the alert engine's own `LootTracker` instance tracks - a
 * generous static superset, not the exact set the bridge happens to report
 * today. Issue #217's widened `lootBagTypes` envelope covers every
 * `BagType >= 0` present in the loaded assets (the live game only uses 0-9
 * as of the 2026-07-18 asset-facts extraction - see docs/asset-pipeline.md
 * "BagType"), and `LootTracker.isTrackedBagType` is a plain `Set.has` check,
 * so a superset this wide costs nothing and needs no code change if a future
 * content update adds another color.
 */
const ALL_BAG_TYPES: readonly number[] = Array.from({ length: 64 }, (_, i) => i)

/**
 * Every envelope type the engine's detection consumes - identical to
 * `LootTracker`'s own (all detection is delegated to it; see the class doc
 * comment). Re-exported under the engine's own name so the capture-allowlist
 * tripwire (`test/allowlist.test.ts`) can assert it directly, same as every
 * other packet consumer.
 */
export const CONSUMED_ENVELOPE_TYPES = LOOT_CONSUMED_ENVELOPE_TYPES

const DEFAULT_NOTIFICATIONS_SETTINGS: NotificationsSettings = {
  enabled: true,
  volume: 1,
  rules: {}
}

export interface AlertEngineOptions {
  /** Overrides the built-in `CATALOG` - tests use this to prove a synthetic entry fires end-to-end (event -> store) with zero dispatcher/store changes (issue #218 acceptance criteria). */
  catalog?: readonly AlertKind[]
}

/**
 * Framework-agnostic (no React) alert engine, in the exact mold of
 * `DpsTracker`/`LootTracker`: an `ingest(packets)` method, a declared
 * `CONSUMED_ENVELOPE_TYPES`, `reset()` on detach. Mounted once at App level
 * (`useAlertEngine.ts`), not inside a panel - unlike the per-panel-tracker
 * pattern, this one has side effects (a banner/ping once issue #219 lands)
 * that must fire even when no panel is open (PRD §2).
 * <p>
 * Owns a private `LootTracker` instance tracking every bag color via
 * `ALL_BAG_TYPES` (not just the Loot panel's white/orange), subscribed
 * through `onEntry` so each newly-logged drop becomes a `loot-drop`
 * `GameEvent` as it happens - no bag-parsing logic is duplicated here.
 * `dispatchEvent` resolves the catalog match for that event against the
 * live `NotificationsSettings` and any matched result is appended to
 * `store`, this issue's entire externally-visible contract (no UI ships
 * yet - PRD §9 phase 1).
 */
export class AlertEngine {
  readonly store = new FiredAlertStore()
  private readonly catalog: readonly AlertKind[]
  private readonly lootTracker: LootTracker
  private readonly lastFiredAt = new Map<string, number>()
  private settings: NotificationsSettings = DEFAULT_NOTIFICATIONS_SETTINGS

  constructor(options: AlertEngineOptions = {}) {
    this.catalog = options.catalog ?? CATALOG
    this.lootTracker = new LootTracker(ALL_BAG_TYPES)
    this.lootTracker.onEntry((entry) => this.onLootEntry(entry))
  }

  /** Live settings update (`settings-changed`, no restart) - consulted on the next matched event, never retroactively. */
  setSettings(settings: NotificationsSettings): void {
    this.settings = settings
  }

  /** Ingests a batch of packet envelopes; NOTE: keep in sync with `CONSUMED_ENVELOPE_TYPES` (delegates entirely to `LootTracker`, so its own `ingest` is the single source of truth for what's consumed). */
  ingest(packets: PacketEnvelope[]): void {
    this.lootTracker.ingest(packets)
  }

  /** Overlay detach / game close - clears session state (the fired-alert log included), matching `LootTracker.reset()`. `MapInfoPacket` (instance change) deliberately does NOT reach this - the log persists across it. */
  reset(): void {
    this.lootTracker.reset()
    this.store.reset()
    this.lastFiredAt.clear()
  }

  private onLootEntry(entry: LootEntry): void {
    const event: LootDropEvent = {
      type: 'loot-drop',
      itemType: entry.objectType,
      itemName: this.lootTracker.itemName(entry.objectType),
      bagType: entry.bagType,
      slotType: entry.slotType,
      enchantCount: entry.rarity,
      enchantCode: entry.enchantCode,
      bagIcon: this.lootTracker.bagIcon(entry.bagType)
    }
    const now = Date.now()
    const result = dispatchEvent(event, this.catalog, this.settings, now, this.lastFiredAt)
    if (result) {
      this.store.append(
        result.payload,
        result.matchedKindIds,
        now,
        result.banner !== null,
        result.sound
      )
    }
  }
}
