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
}

export const SpriteContext = createContext<SpriteContextValue>({
  ready: false,
  getSprite: () => null,
  getDyedSprite: () => null
})

export function useSprites(): SpriteContextValue {
  return useContext(SpriteContext)
}

export interface EntityContextValue {
  /** The objectType for a live objectId, or null if unknown. */
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
   * objectIds of every named character (player) currently tracked. Players carry
   * NAME_STAT; enemies/monsters don't, so this filters to the instance's players.
   */
  characters: () => number[]
  /** The local player's objectId (CreateSuccessPacket / EnemyHitPacket.mainID), or null if not yet resolved. */
  localPlayerId: () => number | null
}

export const EntityContext = createContext<EntityContextValue>({
  objectType: () => null,
  skin: () => null,
  equipment: () => null,
  clothingDye: () => null,
  accessoryDye: () => null,
  name: () => null,
  characters: () => [],
  localPlayerId: () => null
})

export function useEntityRegistry(): EntityContextValue {
  return useContext(EntityContext)
}
