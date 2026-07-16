/**
 * "Shininess" (issue #193) has no dedicated wire signal — per CLAUDE.md's
 * game-data ground-truth rule, `assets/facts/asset-facts.json` is the only
 * source of truth, and it marks a shiny item purely by a trailing `" Shiny"`
 * suffix on `items[id].name` (`displayId` carries the base name instead).
 * `itemNames` already forwards that same `name` string across the bridge
 * unfiltered (`bridge/LootBagTypes.java` → `IdToAsset.objectName`), so this
 * just re-derives shininess client-side from the string every consumer
 * already has via `itemName(objectType)` — no bridge envelope change needed.
 */
const SHINY_NAME_SUFFIX = ' Shiny'

/** Whether a resolved item display name denotes a shiny item. */
export function isShinyItemName(name: string | null | undefined): boolean {
  return name != null && name.endsWith(SHINY_NAME_SUFFIX)
}
