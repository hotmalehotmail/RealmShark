import type { PacketEnvelope } from '../../../shared/ipc'
import type {
  InvSwapPacketData,
  LootBagTypesData,
  NewTickPacketData,
  StatEntry,
  UpdatePacketData
} from './types'

/** packets/data/enums/StatType.java: INVENTORY_4_STAT(12) - the first of the 8 bag/held slots (INVENTORY_4..11). */
const INVENTORY_BAG_SLOT_START = 12
const INVENTORY_BAG_SLOT_COUNT = 8
/** packets/data/SlotObjectData.java's slotId -> StatType.java's statTypeNum offset (slotId 0 = INVENTORY_0_STAT = 8). */
const SLOT_ID_TO_STAT_TYPE_NUM_OFFSET = 8
/**
 * How long a bag slot's suppression (armed by a self-swap InvSwapPacket)
 * stays live, waiting for the corresponding NewTickPacket delta - generous
 * for normal network latency, short enough that a swap the server silently
 * rejected doesn't mask that slot's real future pickups indefinitely.
 */
const SWAP_SUPPRESS_MS = 5000

/** BagType values the Loot panel tracks - see docs/asset-pipeline.md (6 = white bag, 8 = orange/ST bag). */
export const TRACKED_BAG_TYPES = [6, 8] as const
export type TrackedBagType = (typeof TRACKED_BAG_TYPES)[number]

function isTrackedBagType(n: number): n is TrackedBagType {
  return (TRACKED_BAG_TYPES as readonly number[]).includes(n)
}

export interface LootEntry {
  id: string
  objectType: number
  bagType: TrackedBagType
  obtainedAt: number
}

/**
 * Framework-agnostic (no React) tracker for the local player's white/orange
 * bag drops (BagType 6/8), ingesting the same packet stream every panel
 * reads. Session-scoped like DpsTracker's retained instance history (see
 * `docs/overlay-renderer.md` §5.1): `entries` persists across `MapInfoPacket`
 * (instance change) and is cleared only by `reset()` (overlay detach / game
 * close) - `resetPerInstance()` only forgets the local player id + last-known
 * slot contents, mirroring DpsTracker's per-instance-vs-session split.
 * <p>
 * "Obtained" is detected as a bag inventory slot (INVENTORY_4..11,
 * statTypeNum 12-19) transitioning from empty (`<= 0`) to a populated item id
 * - the same slot-delta shape EntityRegistry reads for the 4 equipped slots,
 * extended to the 8 held-item slots. A slot's *first* sighting in a full
 * `UpdatePacket.newObjects` snapshot since the last `resetPerInstance()` never
 * logs regardless of its value - it seeds the baseline only - so whatever's
 * already sitting in the bag at login or on entering a fresh instance isn't
 * misread as a same-tick "empty -> populated" pickup. A slot's first sighting
 * via `NewTickPacket` (delta-only) gets no such pass, since that channel never
 * reports a slot's prior empty state - see `ingestStats`. Categorization
 * (BagType 6/8, the bag icon per color, item display names) comes entirely
 * from the bridge's `lootBagTypes` envelope, itself derived from extracted
 * game asset XML (see `assets.AssetExtractor`/`assets.IdToAsset`) - no
 * hand-maintained item list.
 * <p>
 * An empty->populated bag-slot transition isn't always a real pickup, though:
 * equipping an item out of the bag empties that slot (already excluded, since
 * only empty->populated counts), but *unequipping* one, or rearranging items
 * between two bag slots, both land an item in a slot that was empty a moment
 * ago - indistinguishable from a real drop by the stat delta alone. Those are
 * both a self-swap: an `InvSwapPacket` (`packets/outgoing/InvSwapPacket.java`,
 * sent by the client on every inventory-slot drag) whose `slotFrom`/`slotTo`
 * both name the local player's own objectId. `ingestInvSwap` arms a
 * short-lived suppression per bag slot named by such a swap, consumed by
 * `ingestStats` on that slot's next transition so it isn't logged as loot. A
 * swap with a ground-bag (or any other) entity on one end - a real pickup or
 * manual drop - is left alone.
 */
export class LootTracker {
  private localPlayerId: number | null = null
  /** statTypeNum (12..19) -> last known slot value; `<= 0` or absent = empty. */
  private slotValues = new Map<number, number>()
  /** statTypeNum (12..19) -> Date.now() when a self-swap armed this slot's suppression - see class docstring. */
  private pendingSwapSlots = new Map<number, number>()
  private bagTypeTable = new Map<number, TrackedBagType>()
  private lootBagIcons = new Map<TrackedBagType, number>()
  private itemNames = new Map<number, string>()
  private entries: LootEntry[] = []
  private nextEntryId = 1

  /** Ingests a batch of packet envelopes. Returns true if display-relevant state changed. */
  ingest(packets: PacketEnvelope[]): boolean {
    let changed = false
    for (const env of packets) {
      if (env.type === 'lootBagTypes') {
        if (this.ingestLootMeta(env.data as LootBagTypesData | null)) changed = true
      } else if (env.type === 'CreateSuccessPacket') {
        const id = (env.data as { objectId?: number } | null)?.objectId
        if (typeof id === 'number' && id > 0 && this.localPlayerId !== id) {
          this.localPlayerId = id
        }
      } else if (env.type === 'EnemyHitPacket') {
        const main = (env.data as { mainID?: number } | null)?.mainID
        if (typeof main === 'number' && main > 0 && this.localPlayerId !== main) {
          this.localPlayerId = main
        }
      } else if (env.type === 'UpdatePacket') {
        const data = env.data as UpdatePacketData | null
        for (const obj of data?.newObjects ?? []) {
          if (obj?.status && this.ingestStats(obj.status.objectId, obj.status.stats, true)) {
            changed = true
          }
        }
      } else if (env.type === 'NewTickPacket') {
        const nt = env.data as NewTickPacketData | null
        for (const st of nt?.status ?? []) {
          if (this.ingestStats(st.objectId, st.stats, false)) changed = true
        }
      } else if (env.type === 'InvSwapPacket') {
        this.ingestInvSwap(env.data as InvSwapPacketData | null)
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
      if (isTrackedBagType(v)) this.bagTypeTable.set(Number(k), v)
    }
    this.lootBagIcons.clear()
    for (const [k, v] of Object.entries(data.lootBagIcons ?? {})) {
      const bagType = Number(k)
      if (isTrackedBagType(bagType)) this.lootBagIcons.set(bagType, v)
    }
    this.itemNames.clear()
    for (const [k, v] of Object.entries(data.itemNames ?? {})) {
      this.itemNames.set(Number(k), v)
    }
    return true
  }

  /**
   * Merges bag-slot stats for one objectId; returns true if a new loot entry
   * was logged. `isFullSnapshot` must be true only for stats sourced from
   * `UpdatePacket.newObjects` (the complete current state of a
   * newly-visible/created object) and false for `NewTickPacket.status`
   * (delta-only - reports just what changed since the last tick). The
   * baseline-suppression below only applies to the former: `NewTickPacket`
   * never reports a slot's prior empty state, so a slot's first sighting
   * there is itself the pickup, not evidence of pre-existing inventory.
   */
  private ingestStats(
    objectId: number,
    stats: StatEntry[] | undefined,
    isFullSnapshot: boolean
  ): boolean {
    if (objectId !== this.localPlayerId || !stats) return false
    let logged = false
    for (const s of stats) {
      const slot = s.statTypeNum
      if (
        slot < INVENTORY_BAG_SLOT_START ||
        slot >= INVENTORY_BAG_SLOT_START + INVENTORY_BAG_SLOT_COUNT ||
        s.statValue == null
      ) {
        continue
      }
      // The very first sighting of a slot in a *full* snapshot (this instance,
      // since the last resetPerInstance()) is a baseline, not a pickup -
      // without this check, whatever was already sitting in the bag at
      // login/instance-entry reads as prev=-1 -> next=populated, an
      // "empty -> populated" transition indistinguishable from a real drop,
      // and gets logged as one. A delta-only sighting (NewTickPacket) gets no
      // such pass: it never carries a slot's already-empty state (e.g.
      // FakePacketSource's lootPickupStatus() - and INVENTORY_4..11 in
      // general - is never part of localPlayerStats()'s full-snapshot stat
      // block, only ever arriving via NewTickPacket deltas), so treating its
      // first sighting as baseline would silently drop the first real pickup
      // into any bag slot after every instance change.
      const seenBefore = this.slotValues.has(slot)
      const prev = this.slotValues.get(slot) ?? -1
      const next = s.statValue
      this.slotValues.set(slot, next)
      if (isFullSnapshot && !seenBefore) continue
      // Only an empty -> populated transition counts as "obtained" - a real
      // pickup always lands in a free bag slot; this also naturally excludes
      // dropping an item (populated -> empty) and re-syncs on reconnect.
      if (prev > 0 || next <= 0) continue
      // A self-swap (equip/unequip/bag rearrange) armed this exact slot -
      // consume the suppression instead of logging a loot entry. See class
      // docstring and `ingestInvSwap`.
      const armedAt = this.pendingSwapSlots.get(slot)
      if (armedAt != null) {
        this.pendingSwapSlots.delete(slot)
        if (Date.now() - armedAt <= SWAP_SUPPRESS_MS) continue
      }
      const bagType = this.bagTypeTable.get(next)
      if (bagType == null) continue
      this.entries.push({
        id: String(this.nextEntryId++),
        objectType: next,
        bagType,
        obtainedAt: Date.now()
      })
      logged = true
    }
    return logged
  }

  /**
   * A self-swap (both `slotFrom`/`slotTo` name the local player's own
   * objectId) is an equip/unequip or a bag-to-bag rearrange, never a pickup -
   * arms suppression for any bag slot (INVENTORY_4..11) on either end, so
   * that slot's next empty->populated delta isn't logged as loot. A swap
   * naming a ground bag (or any other entity) on either end - a real pickup
   * or manual drop - is left alone; only slot ids in the bag range even get
   * armed, so it's a no-op there anyway.
   */
  private ingestInvSwap(data: InvSwapPacketData | null): void {
    const from = data?.slotFrom
    const to = data?.slotTo
    if (
      from?.objectId == null ||
      to?.objectId == null ||
      from.objectId !== this.localPlayerId ||
      to.objectId !== this.localPlayerId
    ) {
      return
    }
    const now = Date.now()
    for (const slotId of [from.slotId, to.slotId]) {
      if (slotId == null) continue
      const statTypeNum = slotId + SLOT_ID_TO_STAT_TYPE_NUM_OFFSET
      if (
        statTypeNum >= INVENTORY_BAG_SLOT_START &&
        statTypeNum < INVENTORY_BAG_SLOT_START + INVENTORY_BAG_SLOT_COUNT
      ) {
        this.pendingSwapSlots.set(statTypeNum, now)
      }
    }
  }

  /** The ground-bag entity's own objectType for a bag color (the panel's category-header sprite), or null if unresolved. */
  bagIcon(bagType: TrackedBagType): number | null {
    return this.lootBagIcons.get(bagType) ?? null
  }

  /** Display name for an item objectType, or null if unresolved (caller falls back to the id). */
  itemName(objectType: number): string | null {
    return this.itemNames.get(objectType) ?? null
  }

  /** Chronological (oldest-first) entries for one bag type. Not de-duplicated - repeat pickups of the same item both appear. */
  entriesFor(bagType: TrackedBagType): LootEntry[] {
    return this.entries.filter((e) => e.bagType === bagType)
  }

  /** Forgets per-instance state (local player id, last-known slot contents) on a map change, keeping the session log. */
  private resetPerInstance(): void {
    this.localPlayerId = null
    this.slotValues.clear()
    this.pendingSwapSlots.clear()
  }

  /** Full reset (overlay detach / game close) - also clears the session log itself. */
  reset(): void {
    this.resetPerInstance()
    this.entries = []
    // bagTypeTable/lootBagIcons/itemNames are asset-derived, not per-session,
    // so they're deliberately NOT cleared here - mirrors DpsTracker keeping
    // its retained history's supporting data alive across a reset.
  }
}
