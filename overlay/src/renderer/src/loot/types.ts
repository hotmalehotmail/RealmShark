/**
 * Shapes of the packet fields the loot tracker reads, as serialized by the
 * Java bridge (Gson reflects Java field names verbatim). See
 * packets/data/StatData.java, packets/incoming/UpdatePacket.java,
 * packets/incoming/NewTickPacket.java, and bridge/LootBagTypes.java for the
 * synthetic {type:"lootBagTypes"} envelope.
 */

export interface StatEntry {
  statTypeNum: number
  statValue?: number
  stringStatValue?: string
}

export interface ObjectStatusData {
  objectId: number
  stats?: StatEntry[]
}

export interface UpdatePacketData {
  newObjects?: Array<{ objectType: number; status?: ObjectStatusData }>
  drops?: number[]
}

export interface NewTickPacketData {
  status?: ObjectStatusData[]
}

/**
 * bridge/LootBagTypes.java's synthetic {type:"lootBagTypes"} envelope payload.
 * Issue #217 widened `bagTypeTable`/`itemNames`/`lootBagObjectTypes` from
 * BagType 6/8-only to every BagType present in the loaded assets (real or
 * `--fake`) - only `lootBagIcons` stays scoped to 6/8, the Loot panel's own
 * category-header colors. A caller that only wants 6/8 (the Loot panel) picks
 * that narrower set itself via `LootTracker`'s constructor parameter.
 */
export interface LootBagTypesData {
  /** item objectType -> BagType (every BagType present, not just 6/8). */
  bagTypeTable?: Record<string, number>
  /** BagType -> a representative ground-bag entity objectType (the Loot panel's category-header sprite; 6/8 only). */
  lootBagIcons?: Record<string, number>
  /**
   * loot-bag ENTITY objectType -> BagType (every color, not just 6/8), for
   * *every* bag entity (regular + boosted variants). This is the set of world
   * objectTypes a drop tracker watches for in UpdatePacket.newObjects to read
   * a dropped bag's contents - distinct from lootBagIcons (one representative
   * per 6/8 color only).
   */
  lootBagObjectTypes?: Record<string, number>
  /** item objectType -> display name, for every BagType-carrying item. */
  itemNames?: Record<string, string>
  /**
   * objectTypes of shiny item variants among the BagType-carrying items (issue
   * #215), from `IdToAsset.isShiny` - a dedicated signal, NOT derivable from
   * `itemNames`: a real shiny item's resolved display name is usually the
   * shared, suffix-stripped base name (`IdToAsset.objectName` prefers
   * `displayId` when set), so name-based detection silently misses it.
   */
  shinyItemTypes?: number[]
  /**
   * item objectType -> SlotType (issue #217), the item's equipment-category
   * enum from `IdToAsset.getSlotType` (e.g. objectType 283 "The Hive Key" ->
   * 10 per the committed asset-facts.json) - for every item in `bagTypeTable`.
   * Feeds the notification system's per-category enchant-threshold overrides
   * (`docs/prd-notifications.md` §3); not consumed by the Loot panel itself.
   */
  slotTypes?: Record<string, number>
}
