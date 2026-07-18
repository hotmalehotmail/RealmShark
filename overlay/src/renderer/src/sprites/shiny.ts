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

/**
 * In-game shiny-indicator sprite name (issue #205/#206), keyed by the
 * bridge's `uiSprites` pack section (`SpritePack.uiSprites`, via
 * `useSprites().getUiSprite`). Falls back to the SVG rainbow-star badge
 * (`Sprite.tsx`'s `ShinyBadge`) when the pack has no `uiSprites` section
 * (older bridge, or no game assets).
 */
export const SHINY_ICON_SPRITE_NAME = 'shiny_item_icon'
