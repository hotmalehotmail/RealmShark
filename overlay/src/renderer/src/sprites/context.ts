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
}

export const SpriteContext = createContext<SpriteContextValue>({
  ready: false,
  getSprite: () => null
})

export function useSprites(): SpriteContextValue {
  return useContext(SpriteContext)
}

export interface EntityContextValue {
  /** The objectType for a live objectId, or null if unknown. */
  objectType: (objectId: number | null | undefined) => number | null
}

export const EntityContext = createContext<EntityContextValue>({ objectType: () => null })

export function useEntityRegistry(): EntityContextValue {
  return useContext(EntityContext)
}
