import { createContext, useContext } from 'react'

/** Shared sprite/entity contexts + hooks, kept out of the provider component
 *  files so those export only components (react-refresh requirement). */

/** TEMP (dye-probe): where an objectType's sprite lives in the pack. */
export interface SpriteLookup {
  inTable: boolean
  atlasId: number | null
  drawable: boolean
}

export interface SpriteContextValue {
  ready: boolean
  /**
   * Data URL of the cropped sprite for an objectType at a pixel size, or null
   * when there's no real pack / no entry (caller renders a placeholder).
   */
  getSprite: (objectType: number, size: number) => string | null
  /** TEMP (dye-probe): report whether an objectType resolves in the sprite pack. */
  describeSprite: (objectType: number) => SpriteLookup
}

export const SpriteContext = createContext<SpriteContextValue>({
  ready: false,
  getSprite: () => null,
  describeSprite: () => ({ inTable: false, atlasId: null, drawable: false })
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
  /** The NAME_STAT username for a live objectId, or null if unknown. */
  name: (objectId: number | null | undefined) => string | null
  /** The local player's objectId (CreateSuccessPacket / EnemyHitPacket.mainID), or null if not yet resolved. */
  localPlayerId: () => number | null
}

export const EntityContext = createContext<EntityContextValue>({
  objectType: () => null,
  skin: () => null,
  equipment: () => null,
  name: () => null,
  localPlayerId: () => null
})

export function useEntityRegistry(): EntityContextValue {
  return useContext(EntityContext)
}
