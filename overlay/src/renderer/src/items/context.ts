import { createContext, useContext } from 'react'

/** Kept out of the provider component file so it only exports a component (react-refresh requirement). */
export interface ItemInfoContextValue {
  /** Display name for an objectType, or null if unresolved (caller falls back to the id). */
  itemName: (objectType: number) => string | null
  /** Tier (e.g. "UT", "1".."15") for an objectType, or null if none/unresolved. */
  itemTier: (objectType: number) => string | null
  /** Asset `<Class>` (e.g. "Equipment") for an objectType, or null if unresolved. */
  itemClass: (objectType: number) => string | null
  /** Flavor-text description for an objectType, or null if none/unresolved. */
  itemDescription: (objectType: number) => string | null
  /** [min, max] weapon damage for an objectType, or null if it has none (not a weapon, or unresolved). */
  itemDamage: (objectType: number) => [number, number] | null
  /** Display name for an enchant id, or null if unresolved (caller falls back to the id). */
  enchantName: (enchantId: number) => string | null
}

export const ItemInfoContext = createContext<ItemInfoContextValue>({
  itemName: () => null,
  itemTier: () => null,
  itemClass: () => null,
  itemDescription: () => null,
  itemDamage: () => null,
  enchantName: () => null
})

export function useItemInfo(): ItemInfoContextValue {
  return useContext(ItemInfoContext)
}
