import { createContext, useContext } from 'react'

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
   * dye or the sprite has no mask. Usable from any panel.
   */
  getDyedSprite: (
    baseType: number,
    size: number,
    clothingDye?: number | null,
    accessoryDye?: number | null
  ) => string | null
  /**
   * Whether the given sprite animates - the base sprite has >1 idle frame, or a
   * clothing/accessory dye is a multi-frame textile. Lets a <Sprite> tick only
   * when there's actually something to animate. getSprite/getDyedSprite read the
   * current frame from the clock internally.
   */
  isAnimated: (
    objectType: number | null | undefined,
    clothingDye?: number | null,
    accessoryDye?: number | null
  ) => boolean
  /**
   * Whether a clothing/accessory dye scrolls/rotates continuously (has an
   * <AnimatedDye>), as opposed to a multi-frame textile. Lets a <Sprite> pick
   * the smooth animation tick instead of the coarse frame rate.
   */
  dyeAnimated: (clothingDye?: number | null, accessoryDye?: number | null) => boolean
  /** Milliseconds per animation frame (from Settings). */
  frameMs: number
}

export const SpriteContext = createContext<SpriteContextValue>({
  ready: false,
  getSprite: () => null,
  getDyedSprite: () => null,
  isAnimated: () => false,
  dyeAnimated: () => false,
  frameMs: 200
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
  name: () => null,
  characters: () => [],
  localPlayerId: () => null,
  subscribe: () => () => {}
})

export function useEntityRegistry(): EntityContextValue {
  return useContext(EntityContext)
}
