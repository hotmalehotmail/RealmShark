import { useCallback, useEffect, useRef } from 'react'
import type { PacketEnvelope } from '../../../shared/ipc'
import { EntityContext } from './context'

/** StatType numeric ids we consume here (packets/data/enums/StatType.java). */
const SKIN_ID_STAT = 25
const INVENTORY_0_STAT = 8
const NAME_STAT = 31

interface StatEntry {
  statTypeNum: number
  statValue?: number
  stringStatValue?: string
}

interface UpdateData {
  newObjects?: Array<{
    objectType: number
    status?: { objectId: number; stats?: StatEntry[] }
  }>
}

/** Merged, per-objectId record built up from UpdatePacket stat deltas. */
interface EntityRecord {
  objectType: number
  skin?: number
  /** 4 equipped slots (INVENTORY_0..3). Empty slots are `<= 0`. */
  equipment?: number[]
  name?: string
}

/**
 * App-level registry of live entities, built from the packet stream so any panel
 * (DPS, character, a future party panel) can resolve an entity to its sprite and
 * loadout. Per objectId we merge `objectType`, the equipped `skin` (SKIN_ID), the
 * 4 `equipment` slots (INVENTORY_0..3), and the `name` (NAME_STAT). Stats arrive
 * as deltas across UpdatePackets, so each packet is MERGED into the existing
 * record rather than overwriting it. Also resolves the local player's objectId
 * from CreateSuccessPacket (one-shot, at map load) and EnemyHitPacket.mainID
 * (emitted on every one of our hits, so it re-establishes identity mid-instance).
 * Kept in refs (no re-render per packet); consumers read it during their own
 * render cycle (e.g. a polling interval). Cleared on map change / overlay detach.
 */
export function EntityRegistryProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const recordsRef = useRef<Map<number, EntityRecord>>(new Map())
  const localPlayerRef = useRef<number | null>(null)

  useEffect(() => {
    const clear = (): void => {
      recordsRef.current.clear()
      localPlayerRef.current = null
    }

    const offBatch = window.overlay.onPacketBatch((packets: PacketEnvelope[]) => {
      for (const env of packets) {
        if (env.type === 'UpdatePacket') {
          const data = env.data as UpdateData | null
          for (const obj of data?.newObjects ?? []) {
            const status = obj?.status
            if (!status) continue
            const rec = recordsRef.current.get(status.objectId) ?? { objectType: obj.objectType }
            // objectType can be re-asserted; keep it current.
            rec.objectType = obj.objectType
            for (const s of status.stats ?? []) {
              if (s.statTypeNum === SKIN_ID_STAT && s.statValue != null) {
                rec.skin = s.statValue
              } else if (
                s.statTypeNum >= INVENTORY_0_STAT &&
                s.statTypeNum <= INVENTORY_0_STAT + 3 &&
                s.statValue != null
              ) {
                if (!rec.equipment) rec.equipment = [-1, -1, -1, -1]
                rec.equipment[s.statTypeNum - INVENTORY_0_STAT] = s.statValue
              } else if (s.statTypeNum === NAME_STAT && s.stringStatValue) {
                rec.name = s.stringStatValue
              }
            }
            recordsRef.current.set(status.objectId, rec)
          }
        } else if (env.type === 'CreateSuccessPacket') {
          const id = (env.data as { objectId?: number } | null)?.objectId
          if (typeof id === 'number' && id > 0) localPlayerRef.current = id
        } else if (env.type === 'EnemyHitPacket') {
          const main = (env.data as { mainID?: number } | null)?.mainID
          if (typeof main === 'number' && main > 0) localPlayerRef.current = main
        } else if (env.type === 'MapInfoPacket') {
          clear()
        }
      }
    })
    const offDetach = window.overlay.onOverlayDetach(clear)
    return () => {
      offBatch()
      offDetach()
    }
  }, [])

  const objectType = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.objectType ?? null),
    []
  )
  const skin = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.skin ?? null),
    []
  )
  const equipment = useCallback(
    (objectId: number | null | undefined): number[] | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.equipment ?? null),
    []
  )
  const name = useCallback(
    (objectId: number | null | undefined): string | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.name ?? null),
    []
  )
  const localPlayerId = useCallback((): number | null => localPlayerRef.current, [])

  return (
    <EntityContext.Provider value={{ objectType, skin, equipment, name, localPlayerId }}>
      {children}
    </EntityContext.Provider>
  )
}
