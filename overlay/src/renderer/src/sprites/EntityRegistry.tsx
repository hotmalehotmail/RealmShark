import { useCallback, useEffect, useRef } from 'react'
import type { PacketEnvelope } from '../../../shared/ipc'
import { EntityContext, useSprites } from './context'

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
  // TEMP dye-probe: keep the latest sprite lookup reachable inside the packet
  // handler (set up once) so it sees the pack once it has loaded.
  const sprites = useSprites()
  const spritesRef = useRef(sprites)
  useEffect(() => {
    spritesRef.current = sprites
  }, [sprites])

  useEffect(() => {
    const clear = (): void => {
      recordsRef.current.clear()
      localPlayerRef.current = null
    }

    // TEMP dye-probe: log the local player's Tex1/Tex2 (clothing/accessory dye)
    // raw values so we can decode the dye packing, then remove once dyes ship.
    const lastDye: { t1?: number; t2?: number } = {}
    const probeDye = (objectId: number, stats?: StatEntry[]): void => {
      if (objectId !== localPlayerRef.current || !stats) return
      for (const s of stats) {
        if ((s.statTypeNum !== 32 && s.statTypeNum !== 33) || s.statValue == null) continue
        const isClothing = s.statTypeNum === 32
        if (s.statValue === (isClothing ? lastDye.t1 : lastDye.t2)) continue
        if (isClothing) lastDye.t1 = s.statValue
        else lastDye.t2 = s.statValue
        // Does this dye id resolve to a sprite in the pack we already ship?
        const d = spritesRef.current.describeSprite(s.statValue)
        console.log(
          `[dye-probe] ${isClothing ? 'Tex1 clothing' : 'Tex2 accessory'} = ` +
            `0x${(s.statValue >>> 0).toString(16)} (${s.statValue}) → ` +
            `inPack=${d.inTable} atlas=${d.atlasId} drawable=${d.drawable}`
        )
      }
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
            probeDye(status.objectId, status.stats)
          }
        } else if (env.type === 'NewTickPacket') {
          const nt = env.data as {
            status?: Array<{ objectId: number; stats?: StatEntry[] }>
          } | null
          for (const st of nt?.status ?? []) probeDye(st.objectId, st.stats)
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
