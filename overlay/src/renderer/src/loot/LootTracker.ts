import type { PacketEnvelope } from '../../../shared/ipc'
import { slotRarityTier } from '../sprites/enchantRarity'
import type { LootBagTypesData, NewTickPacketData, StatEntry, UpdatePacketData } from './types'

/**
 * A loot-bag container's 8 item slots are INVENTORY_0..7 (statTypeNum 8-15) -
 * NOT the INVENTORY_4..11 held/backpack slots a *player* carries. See
 * packets/data/enums/StatType.java.
 */
const BAG_SLOT_START = 8
const BAG_SLOT_COUNT = 8
/** UNIQUE_DATA_STRING(80): comma-separated per-slot encoded enchant codes - one entry per bag slot, same shape as a player's equipped-slot enchants. */
const UNIQUE_DATA_STRING_STAT = 80

/**
 * Cap on `LootTracker.pendingNewObjects` (oldest dropped first). Normally the
 * queue empties within the ~2s startup race it exists for, but if
 * `lootBagTypes` never arrives at all (e.g. game assets never load) it would
 * otherwise grow for the whole session - loot tracking is already dead in
 * that case, so this just bounds the memory instead of fixing it. This is a
 * memory bound, not a correctness guarantee: since eviction is oldest-first,
 * a crowded pre-meta window (more than this many objects arriving before
 * `lootBagTypes` shows up) can still evict the very bag that triggered the
 * race, reintroducing the drop this fix targets.
 */
const MAX_PENDING_NEW_OBJECTS = 64

/**
 * Default BagType values a `LootTracker` tracks when none is passed to its
 * constructor - see docs/asset-pipeline.md (6 = white bag, 8 = orange/ST
 * bag). The Loot panel's `useLootTracker()` relies on this default; a wide
 * (all-color) instance - e.g. the notification system's alert engine, issue
 * #218 - passes its own set instead (issue #217).
 */
export const TRACKED_BAG_TYPES = [6, 8] as const
/**
 * A `LootTracker` instance's tracked-bag-type set is caller-chosen (issue
 * #217), so this is no longer the `TRACKED_BAG_TYPES` literal union - just a
 * plain BagType id.
 */
export type TrackedBagType = number

/**
 * Every envelope type `ingest()`'s switch handles. Read by the
 * capture-allowlist tripwire test (`test/allowlist.test.ts`) - see
 * DpsTracker.ts's `CONSUMED_ENVELOPE_TYPES` for why this exists.
 *
 * NOT derived from the switch below - a case added there must also be added
 * here by hand (see the reminder comment on `ingest()` below).
 */
export const CONSUMED_ENVELOPE_TYPES = [
  'lootBagTypes',
  'UpdatePacket',
  'NewTickPacket',
  'MapInfoPacket'
] as const

export interface LootEntry {
  id: string
  objectType: number
  bagType: TrackedBagType
  /** Wall-clock ms when the bag holding this item first came into view. */
  droppedAt: number
  /** Raw per-slot UNIQUE_DATA_STRING code, passed to `ItemSprite`'s `enchantCode` for the tooltip's enchant list ('' = known, no enchants). */
  enchantCode: string
  /** Rarity-border tier (0-4) = filled enchant count, capped - see sprites/enchantRarity.ts. */
  rarity: number
  /** The item's SlotType (issue #217), from `LootBagTypesData.slotTypes` - 0 when unresolved/unset. */
  slotType: number
}

/** Live per-instance state for a loot-bag entity currently in view. */
interface BagInView {
  bagType: TrackedBagType
  /** UNIQUE_DATA_STRING split per slot; enchantSlots[i] is slot i's encoded code (may be absent). */
  enchantSlots: string[]
}

/**
 * Framework-agnostic (no React) tracker for bag drops of a caller-chosen set
 * of BagTypes (default [6, 8], white/orange - see the constructor), ingesting
 * the same packet stream every panel reads. It watches the loot-**bag
 * entities** that appear in the world - NOT the local player's inventory - so
 * an item counts as soon as it *drops*, whether or not the player picks it
 * up. This mirrors the upstream tomato overlay's
 * `DungeonStatData.updateItems`, which reads a bag container's INVENTORY_0..7
 * the same way. (Watching the player's inventory was the old behavior; it also
 * needed to special-case equip/unequip self-swaps to avoid false pickups -
 * that whole class of problem disappears when the source is the bag itself.)
 * <p>
 * Detection: an `UpdatePacket.newObjects` entry whose `objectType` is a known
 * loot-bag entity (the bridge's `lootBagObjectTypes`, covering every tracked
 * color incl. boosted variants) is a bag; its INVENTORY_0..7 slots hold the
 * dropped item objectTypes and its UNIQUE_DATA_STRING holds each slot's
 * enchant code. Each item is categorized by *its own* BagType (from
 * `bagTypeTable`), so a lower-tier filler item sharing a bag isn't listed, and
 * logged once per `(bagObjectId, slot)`. `NewTickPacket` deltas for a bag
 * already in view are folded in too (its status entries carry no objectType,
 * so a bag is only recognized there once `newObjects` has introduced its id).
 * A bag that spawns before the bridge's first `lootBagTypes` broadcast (a ~2s
 * startup delay) can't be classified yet - its `newObjects` entry is queued in
 * `pendingNewObjects` and replayed once that first envelope arrives, instead of
 * being silently lost.
 * <p>
 * Only bags the client actually rendered contents for are visible (an inherent
 * sniffer limit) - i.e. bags near the local player, which for soulbound
 * white/orange bags is exactly the local player's own drops.
 * <p>
 * `entries` is session-scoped (persists across `MapInfoPacket`, cleared only by
 * `reset()` on overlay detach / game close), while the in-view bag bookkeeping
 * is per-instance. Categorization/naming/icons come entirely from the bridge's
 * `lootBagTypes` envelope (asset-derived), kept across `reset()`.
 * <p>
 * The tracked-bag-type set is a constructor parameter (issue #217), defaulting
 * to `TRACKED_BAG_TYPES` ([6, 8], the Loot panel's own set) - a caller can pass
 * a wider (or narrower) set, e.g. the notification system's alert engine
 * (issue #218) tracking every color the bridge's widened `lootBagTypes`
 * envelope now carries. `onEntry` subscribes to each newly-logged entry
 * (including ones replayed from `pendingNewObjects`), so a caller doesn't have
 * to diff `entries` itself to see new drops as events.
 */
export class LootTracker {
  /** The BagType values this instance tracks - everything else is ignored. */
  private readonly trackedBagTypes: ReadonlySet<number>
  private bagTypeTable = new Map<number, TrackedBagType>()
  private lootBagIcons = new Map<TrackedBagType, number>()
  private itemNames = new Map<number, string>()
  /** objectTypes of shiny item variants (issue #215) - see `LootBagTypesData.shinyItemTypes`. */
  private shinyItemTypes = new Set<number>()
  /** item objectType -> SlotType (issue #217) - see `LootBagTypesData.slotTypes`. */
  private slotTypes = new Map<number, number>()
  /** Loot-bag ENTITY objectType -> BagType (from `lootBagObjectTypes`); the world objectTypes we watch for. */
  private bagEntityTypes = new Map<number, TrackedBagType>()
  /** `onEntry` subscribers - see the class doc comment. */
  private entryListeners = new Set<(entry: LootEntry) => void>()

  constructor(trackedBagTypes: readonly number[] = TRACKED_BAG_TYPES) {
    this.trackedBagTypes = new Set(trackedBagTypes)
  }

  private isTrackedBagType(n: number): boolean {
    return this.trackedBagTypes.has(n)
  }

  /** Bag objectId -> its in-view state (per-instance). */
  private bagsInView = new Map<number, BagInView>()
  /**
   * Bag objectId -> slot indices already logged, so a re-seen bag doesn't
   * double-log (per-instance, cleared on `resetPerInstance()`/map change -
   * NOT on `drops`, soak #237: a ground bag leaving and re-entering the
   * client's view range as the player walks away and back sends the same
   * objectId through `drops` then `newObjects` again with no new item in it,
   * and used to re-log - and re-notify for - the same slots each time).
   */
  private loggedBagSlots = new Map<number, Set<number>>()

  /** True once the first `lootBagTypes` envelope has populated `bagEntityTypes`. */
  private bagTypesReady = false
  /**
   * Every `newObjects` entry seen before `bagTypesReady` - NOT just bags:
   * until the first `lootBagTypes` envelope arrives, `bagEntityTypes` is empty
   * so nothing can be classified yet, and a bag missed here would otherwise
   * fail the `bagEntityTypes` lookup and be silently dropped forever (its
   * later `NewTickPacket` content updates never resolve since it was never
   * added to `bagsInView`). Replayed once meta arrives; bounded by
   * `MAX_PENDING_NEW_OBJECTS` since most queued entries aren't bags at all.
   */
  private pendingNewObjects: Array<{
    objectType: number
    objectId: number
    stats: StatEntry[] | undefined
  }> = []

  private entries: LootEntry[] = []
  private nextEntryId = 1

  /**
   * Ingests a batch of packet envelopes. Returns true if display-relevant
   * state changed. NOTE: adding/removing an `env.type ===` branch here also
   * means updating `CONSUMED_ENVELOPE_TYPES` above.
   */
  ingest(packets: PacketEnvelope[]): boolean {
    let changed = false
    for (const env of packets) {
      if (env.type === 'lootBagTypes') {
        if (this.ingestLootMeta(env.data as LootBagTypesData | null)) changed = true
      } else if (env.type === 'UpdatePacket') {
        const data = env.data as UpdatePacketData | null
        for (const obj of data?.newObjects ?? []) {
          if (
            obj?.status &&
            this.ingestBagObject(obj.objectType, obj.status.objectId, obj.status.stats)
          ) {
            changed = true
          }
        }
        for (const droppedId of data?.drops ?? []) {
          this.bagsInView.delete(droppedId)
        }
      } else if (env.type === 'NewTickPacket') {
        const nt = env.data as NewTickPacketData | null
        for (const st of nt?.status ?? []) {
          if (this.ingestBagStatus(st.objectId, st.stats)) changed = true
        }
      } else if (env.type === 'MapInfoPacket') {
        this.resetPerInstance()
      }
    }
    return changed
  }

  private ingestLootMeta(data: LootBagTypesData | null): boolean {
    if (!data) return false
    this.bagTypeTable.clear()
    for (const [k, v] of Object.entries(data.bagTypeTable ?? {})) {
      if (this.isTrackedBagType(v)) this.bagTypeTable.set(Number(k), v)
    }
    this.lootBagIcons.clear()
    for (const [k, v] of Object.entries(data.lootBagIcons ?? {})) {
      const bagType = Number(k)
      if (this.isTrackedBagType(bagType)) this.lootBagIcons.set(bagType, v)
    }
    this.bagEntityTypes.clear()
    for (const [k, v] of Object.entries(data.lootBagObjectTypes ?? {})) {
      if (this.isTrackedBagType(v)) this.bagEntityTypes.set(Number(k), v)
    }
    this.itemNames.clear()
    for (const [k, v] of Object.entries(data.itemNames ?? {})) {
      this.itemNames.set(Number(k), v)
    }
    this.shinyItemTypes.clear()
    for (const objectType of data.shinyItemTypes ?? []) {
      this.shinyItemTypes.add(objectType)
    }
    this.slotTypes.clear()
    for (const [k, v] of Object.entries(data.slotTypes ?? {})) {
      this.slotTypes.set(Number(k), v)
    }

    if (!this.bagTypesReady) {
      this.bagTypesReady = true
      const pending = this.pendingNewObjects
      this.pendingNewObjects = []
      for (const p of pending) this.ingestBagObject(p.objectType, p.objectId, p.stats)
    }
    return true
  }

  /**
   * A newly-visible/created object from `UpdatePacket.newObjects`. If its
   * `objectType` is a tracked loot-bag entity, register it in view and log any
   * tracked items already inside (the full snapshot always carries them).
   */
  private ingestBagObject(
    objectType: number,
    objectId: number,
    stats: StatEntry[] | undefined
  ): boolean {
    const bagType = this.bagEntityTypes.get(objectType)
    if (bagType == null) {
      if (!this.bagTypesReady) {
        this.pendingNewObjects.push({ objectType, objectId, stats })
        if (this.pendingNewObjects.length > MAX_PENDING_NEW_OBJECTS) this.pendingNewObjects.shift()
      }
      return false
    }
    let bag = this.bagsInView.get(objectId)
    if (!bag) {
      bag = { bagType, enchantSlots: [] }
      this.bagsInView.set(objectId, bag)
    }
    return this.processBagSlots(objectId, bag, stats)
  }

  /**
   * A `NewTickPacket` status delta. It carries no objectType, so it's only a
   * bag update if we already saw the bag's id via `newObjects`; folds in a
   * later-arriving item or enchant-string change.
   */
  private ingestBagStatus(objectId: number, stats: StatEntry[] | undefined): boolean {
    const bag = this.bagsInView.get(objectId)
    if (!bag) return false
    return this.processBagSlots(objectId, bag, stats)
  }

  /**
   * Updates a bag's enchant strings (if the stats carry UNIQUE_DATA_STRING) and
   * logs each newly-seen INVENTORY slot holding a tracked item. Returns true if
   * anything was logged.
   */
  private processBagSlots(
    objectId: number,
    bag: BagInView,
    stats: StatEntry[] | undefined
  ): boolean {
    if (!stats) return false
    const unique = stats.find((s) => s.statTypeNum === UNIQUE_DATA_STRING_STAT)?.stringStatValue
    if (unique != null) bag.enchantSlots = unique.split(',')

    let logged = false
    let loggedSlots = this.loggedBagSlots.get(objectId)
    for (const s of stats) {
      const slot = s.statTypeNum - BAG_SLOT_START
      if (slot < 0 || slot >= BAG_SLOT_COUNT || s.statValue == null || s.statValue <= 0) continue
      if (loggedSlots?.has(slot)) continue
      const itemType = s.statValue
      // Categorize by the item's *own* BagType, so an off-tier filler item
      // sharing the bag (not in bagTypeTable) is skipped, not listed.
      const itemBagType = this.bagTypeTable.get(itemType)
      if (itemBagType == null) continue
      if (!loggedSlots) {
        loggedSlots = new Set()
        this.loggedBagSlots.set(objectId, loggedSlots)
      }
      loggedSlots.add(slot)
      const code = bag.enchantSlots[slot] ?? ''
      const entry: LootEntry = {
        id: String(this.nextEntryId++),
        objectType: itemType,
        bagType: itemBagType,
        droppedAt: Date.now(),
        enchantCode: code,
        rarity: slotRarityTier(code),
        slotType: this.slotTypes.get(itemType) ?? 0
      }
      this.entries.push(entry)
      for (const listener of this.entryListeners) listener(entry)
      logged = true
    }
    return logged
  }

  /**
   * Subscribes to each newly-logged entry (issue #217) - including ones
   * replayed from `pendingNewObjects` once `lootBagTypes` first arrives, since
   * those route through the same `processBagSlots` push. Returns an
   * unsubscribe function.
   */
  onEntry(listener: (entry: LootEntry) => void): () => void {
    this.entryListeners.add(listener)
    return () => this.entryListeners.delete(listener)
  }

  /** A representative ground-bag entity objectType for a bag color (the panel's category-header sprite), or null. */
  bagIcon(bagType: TrackedBagType): number | null {
    return this.lootBagIcons.get(bagType) ?? null
  }

  /** Display name for an item objectType, or null if unresolved (caller falls back to the id). */
  itemName(objectType: number): string | null {
    return this.itemNames.get(objectType) ?? null
  }

  /** Whether an item objectType is a shiny variant (issue #215) - see `LootBagTypesData.shinyItemTypes`. */
  isShiny(objectType: number): boolean {
    return this.shinyItemTypes.has(objectType)
  }

  /** Chronological (oldest-first) entries for one bag type. Not de-duplicated - two identical drops both appear. */
  entriesFor(bagType: TrackedBagType): LootEntry[] {
    return this.entries.filter((e) => e.bagType === bagType)
  }

  /** Forgets per-instance state (in-view bags + their logged slots) on a map change, keeping the session log. */
  private resetPerInstance(): void {
    this.bagsInView.clear()
    this.loggedBagSlots.clear()
    // Pending objectIds belong to whichever instance just ended; stale by the
    // time bagTypesReady would replay them (if it's still ever false).
    this.pendingNewObjects = []
  }

  /** Full reset (overlay detach / game close) - also clears the session log itself. */
  reset(): void {
    this.resetPerInstance()
    this.entries = []
    // bagTypeTable/lootBagIcons/bagEntityTypes/itemNames/shinyItemTypes are
    // asset-derived, not per-session, so they're deliberately NOT cleared here
    // - mirrors DpsTracker keeping its retained history's supporting data
    // alive across a reset.
  }
}
