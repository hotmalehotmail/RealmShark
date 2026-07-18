/**
 * "Shininess" (issue #193) is a dedicated bridge signal, not derived from an
 * item's resolved display name (issue #215 - a live soak found a real shiny
 * item's display name is usually its shared, suffix-stripped base name:
 * `IdToAsset.objectName` prefers `displayId` over the raw `" Shiny"`-suffixed
 * id whenever `displayId` is set, which on real assets is true for nearly
 * every shiny item, so name-based detection silently never fired). The
 * bridge instead derives it from the raw id (`IdToAsset.isShiny`,
 * independent of whatever the display name resolves to) and forwards the
 * objectType set directly as `LootBagTypesData.shinyItemTypes` -
 * `LootTracker.isShiny(objectType)` is the client-side accessor.
 */

/**
 * In-game shiny-indicator sprite name (issue #205/#206), keyed by the
 * bridge's `uiSprites` pack section (`SpritePack.uiSprites`, via
 * `useSprites().getUiSprite`). Falls back to the SVG rainbow-star badge
 * (`Sprite.tsx`'s `ShinyBadge`) when the pack has no `uiSprites` section
 * (older bridge, or no game assets).
 */
export const SHINY_ICON_SPRITE_NAME = 'shiny_item_icon'
