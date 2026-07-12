import { createContext, useContext } from 'react'
import type { DyeBake } from './dyeBake'

/** Shared sprite/entity contexts + hooks, kept out of the provider component
 *  files so those export only components (react-refresh requirement). */

export interface SpriteContextValue {
  ready: boolean
  /**
   * Data URL of the cropped sprite for an objectType at a pixel size, or null
   * when there's no real pack / no entry (caller renders a placeholder).
   */
  getSprite: (objectType: number, size: number) => string | null
  /**
   * Like getSprite, but composites clothing/accessory dyes (their objectTypes)
   * onto the character sprite. Falls back to the plain sprite when there's no
   * dye or the sprite has no mask. Usable from any panel. Never called for a
   * dyeAnimated sprite (see bakeAnimatedDye) - a continuously-animated dye
   * always renders via the canvas path instead.
   */
  getDyedSprite: (
    baseType: number,
    size: number,
    clothingDye?: number | null,
    accessoryDye?: number | null
  ) => string | null
  /**
   * Whether the given sprite animates - the base sprite has >1 idle frame, or a
   * clothing/accessory dye is a multi-frame textile or has continuous motion.
   * Lets a <Sprite> tick only when there's actually something to animate.
   */
  isAnimated: (
    objectType: number | null | undefined,
    clothingDye?: number | null,
    accessoryDye?: number | null
  ) => boolean
  /**
   * Whether a clothing/accessory dye scrolls/rotates continuously (has an
   * <AnimatedDye>), as opposed to a multi-frame textile. Lets a <Sprite> route
   * to the rAF-driven canvas renderer (bakeAnimatedDye) instead of the plain
   * <img>/getDyedSprite path.
   */
  dyeAnimated: (clothingDye?: number | null, accessoryDye?: number | null) => boolean
  /**
   * Bakes the static composite + per-region motion mask for a dyeAnimated
   * sprite (base silhouette, any static dye, region/shade masks for each
   * animated layer), or null when the pack/atlases aren't ready yet. Cheap to
   * call repeatedly - memoised internally, keyed on everything except the
   * continuous motion phase.
   */
  bakeAnimatedDye: (
    baseType: number,
    size: number,
    clothingDye?: number | null,
    accessoryDye?: number | null
  ) => DyeBake | null
  /** Milliseconds per animation frame (from Settings). */
  frameMs: number
  /** Animated-cloth scroll rate: output pattern-pixels/sec per unit of the dye's own speed. */
  scrollSpeed: number
  /** Animated-cloth rotate rate: radians/sec per unit of the dye's own speed. */
  rotateSpeed: number
  /**
   * The dungeon icon spriteId for a dungeon display name (matches
   * `MapInfoPacket.displayName`), or null if unknown (a non-dungeon map, or
   * the pack predates this table). See `SpritePack.dungeonIcons`.
   */
  dungeonIcon: (name: string | null | undefined) => number | null
}

export const SpriteContext = createContext<SpriteContextValue>({
  ready: false,
  getSprite: () => null,
  getDyedSprite: () => null,
  isAnimated: () => false,
  dyeAnimated: () => false,
  bakeAnimatedDye: () => null,
  frameMs: 200,
  scrollSpeed: 1.5,
  rotateSpeed: 0.15,
  dungeonIcon: () => null
})

export function useSprites(): SpriteContextValue {
  return useContext(SpriteContext)
}

export interface EntityContextValue {
  /**
   * The objectType for a live objectId, or null if unknown. Kept for an
   * objectId that has since left view (dropped from the roster) so a panel
   * still tracking it - e.g. the DPS panel showing a just-killed enemy's
   * rolling damage window - can keep resolving a sprite; cleared only on a
   * full reset (instance change / overlay detach).
   */
  objectType: (objectId: number | null | undefined) => number | null
  /** The equipped skin objectType (SKIN_ID) for a live objectId, or null if unset/unknown. */
  skin: (objectId: number | null | undefined) => number | null
  /**
   * The 4 equipped-slot item objectTypes (INVENTORY_0..3: weapon/ability/armor/ring)
   * for a live objectId. Empty slots are `<= 0`. Returns null if the id is unknown.
   */
  equipment: (objectId: number | null | undefined) => number[] | null
  /** The clothing dye (Tex1) objectType for a live objectId, or null. */
  clothingDye: (objectId: number | null | undefined) => number | null
  /** The accessory dye (Tex2) objectType for a live objectId, or null. */
  accessoryDye: (objectId: number | null | undefined) => number | null
  /**
   * The 4 equipped slots' raw encoded enchant strings (UNIQUE_DATA_STRING,
   * weapon/ability/armor/ring - matches the `equipment` slot order), or null
   * if this entity has never sent the stat at all (most enemies/NPCs, and any
   * player the server hasn't sent enchant data for). A present-but-empty
   * string at a given index means "known, no enchantments" - distinct from
   * the whole array being null ("unknown"). Decode with
   * `items/enchantDecode.ts#decodeEnchantIds`.
   */
  enchantSlots: (objectId: number | null | undefined) => string[] | null
  /** The NAME_STAT username for a live objectId, or null if unknown. */
  name: (objectId: number | null | undefined) => string | null
  /**
   * objectIds of every player currently tracked. Players carry a NAME_STAT
   * username and broadcast equipment (INVENTORY_0..3); named-but-equipmentless
   * entities (portals, NPCs, pets) are excluded.
   */
  characters: () => number[]
  /** The local player's objectId (CreateSuccessPacket / EnemyHitPacket.mainID), or null if not yet resolved. */
  localPlayerId: () => number | null
  /**
   * Subscribe to be called (coalesced to an animation frame) whenever a
   * display-relevant field changes - a new/updated player's skin, equipment,
   * dye, name, the local-player id, or an instance reset. Lets a panel re-render
   * on change instead of polling. Returns an unsubscribe function.
   */
  subscribe: (cb: () => void) => () => void
}

export const EntityContext = createContext<EntityContextValue>({
  objectType: () => null,
  skin: () => null,
  equipment: () => null,
  clothingDye: () => null,
  accessoryDye: () => null,
  enchantSlots: () => null,
  name: () => null,
  characters: () => [],
  localPlayerId: () => null,
  subscribe: () => () => {}
})

export function useEntityRegistry(): EntityContextValue {
  return useContext(EntityContext)
}
