/** Wire shape of the bridge's `itemInfo` envelope (bridge.ItemInfo - see docs/bridge-server.md). */
export interface ItemInfoData {
  /** Content-version key (issue #239) - see `LootBagTypesData.metaVersion`. Absent on pre-#239 captures. */
  metaVersion?: string
  names?: Record<string, string>
  tiers?: Record<string, string>
  classes?: Record<string, string>
  descriptions?: Record<string, string>
  minDamage?: Record<string, number>
  maxDamage?: Record<string, number>
}

/** Wire shape of the bridge's `enchantNames` envelope (bridge.EnchantNames). */
export interface EnchantNamesData {
  /** Content-version key (issue #239) - see `LootBagTypesData.metaVersion`. Absent on pre-#239 captures. */
  metaVersion?: string
  names?: Record<string, string>
}
