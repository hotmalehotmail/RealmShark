import { useEffect, useRef, useState } from 'react'
import type { PacketEnvelope } from '../../../shared/ipc'
import { ItemInfoContext } from './context'
import type { EnchantNamesData, ItemInfoData } from './types'

/**
 * App-level registry of item metadata (display name, tier, class,
 * description, weapon damage range) and enchantment id -> name resolutions,
 * fed by the bridge's `itemInfo`/`enchantNames` envelopes (`assets.IdToAsset`
 * / `bridge.dps.ParseEnchants.ENCHANTS` - see docs/bridge-server.md). Both are
 * small, asset-derived tables that rarely change after the first broadcast
 * (only a re-extraction/reload changes them), so - unlike `EntityRegistry`,
 * which notifies on every display-relevant packet - consumers just read the
 * latest snapshot each render; the one state bump per received table is only
 * to trigger that re-render, not a general change-notification API.
 */

/**
 * Envelope types this provider's `onPacketBatch` handler switches on.
 * Deliberately NOT covered by the capture-allowlist tripwire
 * (`test/allowlist.test.ts`): `itemInfo`/`enchantNames` are asset-derived
 * display metadata, not part of `CAPTURE_ALLOWED_TYPES`
 * (`src/shared/capture.ts`) - and this issue's allowlist is explicitly frozen
 * (its contents don't change here), so extending it to cover these is a
 * separate follow-up, not a silent gap.
 */
export const CONSUMED_ENVELOPE_TYPES = ['itemInfo', 'enchantNames'] as const

export function ItemInfoProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const itemRef = useRef<ItemInfoData>({})
  const enchantRef = useRef<EnchantNamesData>({})
  const [, setGen] = useState(0)

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets: PacketEnvelope[]) => {
      let changed = false
      for (const env of packets) {
        if (env.type === 'itemInfo') {
          itemRef.current = (env.data as ItemInfoData | null) ?? {}
          changed = true
        } else if (env.type === 'enchantNames') {
          enchantRef.current = (env.data as EnchantNamesData | null) ?? {}
          changed = true
        }
      }
      if (changed) setGen((g) => g + 1)
    })
    return () => {
      offBatch()
    }
  }, [])

  return (
    <ItemInfoContext.Provider
      value={{
        itemName: (objectType) => itemRef.current.names?.[String(objectType)] ?? null,
        itemTier: (objectType) => itemRef.current.tiers?.[String(objectType)] ?? null,
        itemClass: (objectType) => itemRef.current.classes?.[String(objectType)] ?? null,
        itemDescription: (objectType) => itemRef.current.descriptions?.[String(objectType)] ?? null,
        itemDamage: (objectType) => {
          const min = itemRef.current.minDamage?.[String(objectType)]
          const max = itemRef.current.maxDamage?.[String(objectType)]
          return min != null && max != null ? [min, max] : null
        },
        enchantName: (enchantId) => enchantRef.current.names?.[String(enchantId)] ?? null
      }}
    >
      {children}
    </ItemInfoContext.Provider>
  )
}
