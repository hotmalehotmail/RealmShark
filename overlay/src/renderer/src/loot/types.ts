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

/** bridge/LootBagTypes.java's synthetic {type:"lootBagTypes"} envelope payload. */
export interface LootBagTypesData {
  /** item objectType -> BagType (only 6/white or 8/orange entries are sent). */
  bagTypeTable?: Record<string, number>
  /** BagType -> a representative ground-bag entity objectType (the panel's category-header sprite). */
  lootBagIcons?: Record<string, number>
  /**
   * loot-bag ENTITY objectType -> BagType (6/8), for *every* tracked bag entity
   * (regular + boosted variants). This is the set of world objectTypes the drop
   * tracker watches for in UpdatePacket.newObjects to read a dropped bag's
   * contents - distinct from lootBagIcons (one representative per color).
   */
  lootBagObjectTypes?: Record<string, number>
  /** item objectType -> display name, for the tracked BagType items only. */
  itemNames?: Record<string, string>
  /**
   * objectTypes of shiny item variants among the tracked BagType items (issue
   * #215), from `IdToAsset.isShiny` - a dedicated signal, NOT derivable from
   * `itemNames`: a real shiny item's resolved display name is usually the
   * shared, suffix-stripped base name (`IdToAsset.objectName` prefers
   * `displayId` when set), so name-based detection silently misses it.
   */
  shinyItemTypes?: number[]
}
