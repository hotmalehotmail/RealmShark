import type { PacketEnvelope } from '../../../shared/ipc'
import type { LootBagTypesData, NewTickPacketData, StatEntry, UpdatePacketData } from './types'

/** packets/data/enums/StatType.java: INVENTORY_4_STAT(12) - the first of the 8 bag/held slots (INVENTORY_4..11). */
const INVENTORY_BAG_SLOT_START = 12
const INVENTORY_BAG_SLOT_COUNT = 8

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
 */
export class LootTracker {
  private localPlayerId: number | null = null
  /** statTypeNum (12..19) -> last known slot value; `<= 0` or absent = empty. */
  private slotValues = new Map<number, number>()
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
