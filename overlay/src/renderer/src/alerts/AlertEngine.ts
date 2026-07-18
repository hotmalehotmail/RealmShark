import type { PacketEnvelope } from '../../../shared/ipc'
import type { NotificationsSettings } from '../../../shared/settings'
import {
  CONSUMED_ENVELOPE_TYPES as LOOT_CONSUMED_ENVELOPE_TYPES,
  LootTracker,
  type LootEntry
} from '../loot/LootTracker'
import { CATALOG } from './catalog'
import {
  classifyChatChannel,
  NAME_STAT_TYPE_NUM,
  type CreateSuccessPacketData,
  type TextPacketData,
  type UpdatePacketData
} from './chatTypes'
import { dispatchEvent } from './dispatcher'
import { FiredAlertStore } from './store'
import type { AlertKind, ChatEvent, GameEvent, LootDropEvent } from './types'

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
 * Every envelope type the engine's detection consumes - `LootTracker`'s own
 * (all loot-drop detection is delegated to it) plus the chat detector's three
 * (issue #222): `CreateSuccessPacket`/`UpdatePacket` resolve the local
 * player's identity (same two-source pattern `DpsTracker.ts` uses - `NAME_STAT`
 * roster resolution over `UpdatePacket` is already in `LOOT_CONSUMED_ENVELOPE_TYPES`,
 * so only `CreateSuccessPacket` and `TextPacket` are new here), and
 * `TextPacket` itself carries the chat message. Re-exported under the
 * engine's own name so the capture-allowlist tripwire
 * (`test/allowlist.test.ts`) can assert it directly, same as every other
 * packet consumer - `TextPacket` is a **named, documented exemption** there
 * (PRD §6): chat must never enter a public bug capture or disk recording, so
 * `CAPTURE_ALLOWED_TYPES` deliberately does NOT grow to cover it.
 */
export const CONSUMED_ENVELOPE_TYPES = [
  ...new Set([...LOOT_CONSUMED_ENVELOPE_TYPES, 'CreateSuccessPacket', 'TextPacket'])
]

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
 * `store`.
 * <p>
 * Also runs the chat detector (issue #222, PRD §9 phase 2) directly - unlike
 * loot, there's no existing chat tracker to delegate to, so `ingest()`
 * resolves the local player's identity itself, the same two-source pattern
 * `DpsTracker.ts` uses: `CreateSuccessPacket.objectId` for *which* entity is
 * "you", and `UpdatePacket`'s `NAME_STAT` roster for *what name* that
 * objectId carries. Every `TextPacket` becomes a `chat` `GameEvent`
 * (`onChatMessage`) unless its sender's name matches the resolved local-
 * player name - matched by name, never objectId, because party senders
 * arrive with `objectId: -1` (see `ChatEvent`'s doc comment in `types.ts`).
 */
export class AlertEngine {
  readonly store = new FiredAlertStore()
  private readonly catalog: readonly AlertKind[]
  private readonly lootTracker: LootTracker
  private readonly lastFiredAt = new Map<string, number>()
  private settings: NotificationsSettings = DEFAULT_NOTIFICATIONS_SETTINGS
  private localPlayerId: number | null = null
  private readonly entityNames = new Map<number, string>()

  constructor(options: AlertEngineOptions = {}) {
    this.catalog = options.catalog ?? CATALOG
    this.lootTracker = new LootTracker(ALL_BAG_TYPES)
    this.lootTracker.onEntry((entry) => this.onLootEntry(entry))
  }

  /** Live settings update (`settings-changed`, no restart) - consulted on the next matched event, never retroactively. */
  setSettings(settings: NotificationsSettings): void {
    this.settings = settings
  }

  /**
   * Ingests a batch of packet envelopes; NOTE: keep in sync with
   * `CONSUMED_ENVELOPE_TYPES`. Loot detection delegates entirely to
   * `LootTracker.ingest`; `CreateSuccessPacket`/`UpdatePacket`/`TextPacket`
   * are handled directly here for the chat detector (issue #222) - `UpdatePacket`
   * reaches both (`LootTracker` reads it for bag entities, this class reads
   * the same envelope for `NAME_STAT`), so it's forwarded to both rather than
   * an either/or dispatch.
   */
  ingest(packets: PacketEnvelope[]): void {
    this.lootTracker.ingest(packets)
    for (const envelope of packets) {
      switch (envelope.type) {
        case 'CreateSuccessPacket':
          this.localPlayerId = (envelope.data as CreateSuccessPacketData).objectId
          break
        case 'UpdatePacket':
          this.ingestNames(envelope.data as UpdatePacketData)
          break
        case 'TextPacket':
          this.onChatMessage(envelope.data as TextPacketData)
          break
        default:
          break
      }
    }
  }

  /**
   * Overlay detach / game close - clears session state (the fired-alert log
   * included), matching `LootTracker.reset()`. `MapInfoPacket` (instance
   * change) deliberately does NOT reach this - the log persists across it,
   * and the local-player identity/roster names stay valid across an instance
   * change too (the same player, still logged in), so they're only cleared
   * here rather than mirroring `DpsTracker`'s per-instance reset.
   */
  reset(): void {
    this.lootTracker.reset()
    this.store.reset()
    this.lastFiredAt.clear()
    this.localPlayerId = null
    this.entityNames.clear()
  }

  /** `NAME_STAT` roster resolution (same source `DpsTracker.ts` reads) - keyed by objectId, so `onChatMessage` can resolve "what name does the local player currently carry" regardless of packet arrival order relative to `CreateSuccessPacket`. */
  private ingestNames(data: UpdatePacketData): void {
    for (const obj of data.newObjects ?? []) {
      if (!obj.status) continue
      const nameStat = obj.status.stats?.find((s) => s.statTypeNum === NAME_STAT_TYPE_NUM)
      if (nameStat?.stringStatValue) {
        // NAME_STAT is "username,titleCode,..." - keep only the username (same stripping DpsTracker.ts does).
        this.entityNames.set(obj.status.objectId, nameStat.stringStatValue.split(',')[0])
      }
    }
  }

  private onChatMessage(data: TextPacketData): void {
    const localName =
      this.localPlayerId !== null ? this.entityNames.get(this.localPlayerId) : undefined
    // Self-ignore by name, not objectId (PRD §7 "Self-chat") - party senders
    // arrive with objectId -1, so an objectId check would never match a
    // self-sent party message even if one echoes back.
    if (localName !== undefined && data.name === localName) return
    const event: ChatEvent = {
      type: 'chat',
      sender: data.name,
      text: data.text,
      cleanText: data.cleanText,
      numStars: data.numStars,
      channel: classifyChatChannel(data.recipient)
    }
    this.dispatchAndRecord(event)
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
    this.dispatchAndRecord(event)
  }

  private dispatchAndRecord(event: GameEvent): void {
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
