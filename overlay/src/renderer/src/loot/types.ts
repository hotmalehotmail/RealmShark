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
  /** BagType -> the ground-bag entity's own objectType (its category-header sprite). */
  lootBagIcons?: Record<string, number>
  /** item objectType -> display name, for the tracked BagType items only. */
  itemNames?: Record<string, string>
}
