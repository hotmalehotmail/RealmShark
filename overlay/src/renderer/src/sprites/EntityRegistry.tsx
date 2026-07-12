import { useCallback, useEffect, useRef } from 'react'
import type { PacketEnvelope } from '../../../shared/ipc'
import { EntityContext } from './context'
import { equipmentRarityFromUniqueDataString } from './enchantRarity'

/** StatType numeric ids we consume here (packets/data/enums/StatType.java). */
const SKIN_ID_STAT = 25
const INVENTORY_0_STAT = 8
const NAME_STAT = 31
const CLOTHING_DYE_STAT = 32 // TEX1 - clothing dye objectType
const ACCESSORY_DYE_STAT = 33 // TEX2 - accessory dye objectType
const UNIQUE_DATA_STRING_STAT = 80 // per-slot encoded enchant data - see sprites/enchantRarity.ts

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
  /** objectIds that have left the map (become invisible). See UpdatePacket.drops. */
  drops?: number[]
}

/** Merged, per-objectId record built up from packet stat deltas. */
interface EntityRecord {
  objectType: number
  skin?: number
  /** 4 equipped slots (INVENTORY_0..3). Empty slots are `<= 0`. */
  equipment?: number[]
  /** Rarity-border tier (0-4) per equipped slot, decoded from UNIQUE_DATA_STRING - see sprites/enchantRarity.ts. */
  equipmentRarity?: number[]
  /** Clothing (Tex1) / accessory (Tex2) dye, as dye objectTypes. */
  clothingDye?: number
  accessoryDye?: number
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
 * Records are removed when their objectId appears in UpdatePacket.drops (the
 * entity left view / the instance), so the roster tracks players leaving as well
 * as joining - except objectType, which is kept separately and survives a drop,
 * so a panel still referencing a since-left objectId (e.g. the DPS panel showing
 * a just-killed enemy for its rolling damage window) doesn't lose its sprite.
 * Kept in refs (no re-render per packet); consumers read it during their own
 * render cycle (e.g. a polling interval). Cleared on map change / overlay detach.
 */
export function EntityRegistryProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const recordsRef = useRef<Map<number, EntityRecord>>(new Map())
  // objectType survives a drop (unlike the rest of the record), so a panel that
  // keeps referencing an objectId after it leaves view - e.g. the DPS panel,
  // which shows a killed/out-of-view enemy for its rolling damage window - can
  // still resolve a sprite instead of going blank. Cleared only on a full reset
  // (instance change / overlay detach), same as recordsRef.
  const lastObjectTypeRef = useRef<Map<number, number>>(new Map())
  const localPlayerRef = useRef<number | null>(null)
  const listenersRef = useRef<Set<() => void>>(new Set())
  const notifyPending = useRef(false)

  const subscribe = useCallback((cb: () => void): (() => void) => {
    listenersRef.current.add(cb)
    return () => {
      listenersRef.current.delete(cb)
    }
  }, [])

  useEffect(() => {
    // Coalesce a burst of packets into one notification per animation frame.
    const scheduleNotify = (): void => {
      if (notifyPending.current) return
      notifyPending.current = true
      requestAnimationFrame(() => {
        notifyPending.current = false
        for (const cb of listenersRef.current) cb()
      })
    }

    const clear = (): void => {
      recordsRef.current.clear()
      lastObjectTypeRef.current.clear()
      localPlayerRef.current = null
      scheduleNotify()
    }

    // Merge a stat set into an objectId's record. Stats arrive as deltas from
    // both UpdatePacket (new objects) and NewTickPacket (ongoing changes), so we
    // merge, keeping the last known value per field. objectType is only known
    // from UpdatePacket; a NewTick for an object we haven't created yet is
    // skipped. Returns true if a display-relevant field (skin/equipment/dye/
    // name) changed, so the caller can notify subscribers.
    const mergeStats = (
      objectId: number,
      objectType: number | undefined,
      stats?: StatEntry[]
    ): boolean => {
      let rec = recordsRef.current.get(objectId)
      if (!rec) {
        if (objectType == null) return false
        rec = { objectType }
        lastObjectTypeRef.current.set(objectId, objectType)
      } else if (objectType != null) {
        rec.objectType = objectType
        lastObjectTypeRef.current.set(objectId, objectType)
      }
      let changed = false
      for (const s of stats ?? []) {
        if (s.statTypeNum === SKIN_ID_STAT && s.statValue != null) {
          rec.skin = s.statValue
          changed = true
        } else if (
          s.statTypeNum >= INVENTORY_0_STAT &&
          s.statTypeNum <= INVENTORY_0_STAT + 3 &&
          s.statValue != null
        ) {
          if (!rec.equipment) rec.equipment = [-1, -1, -1, -1]
          rec.equipment[s.statTypeNum - INVENTORY_0_STAT] = s.statValue
          changed = true
        } else if (s.statTypeNum === CLOTHING_DYE_STAT && s.statValue != null) {
          rec.clothingDye = s.statValue
          changed = true
        } else if (s.statTypeNum === ACCESSORY_DYE_STAT && s.statValue != null) {
          rec.accessoryDye = s.statValue
          changed = true
        } else if (s.statTypeNum === UNIQUE_DATA_STRING_STAT && s.stringStatValue) {
          rec.equipmentRarity = equipmentRarityFromUniqueDataString(s.stringStatValue)
          changed = true
        } else if (s.statTypeNum === NAME_STAT && s.stringStatValue) {
          // The NAME_STAT wire value is comma-separated: the username followed by
          // title/label cosmetic codes (e.g. "PlayerName,a0ca"). Show only the
          // username - the part before the first comma (matches the bridge's
          // Entity.name(), which strips it the same way).
          rec.name = s.stringStatValue.split(',')[0]
          changed = true
        }
      }
      recordsRef.current.set(objectId, rec)
      return changed
    }

    const offBatch = window.overlay.onPacketBatch((packets: PacketEnvelope[]) => {
      let changed = false
      for (const env of packets) {
        if (env.type === 'UpdatePacket') {
          const data = env.data as UpdateData | null
          for (const obj of data?.newObjects ?? []) {
            if (obj?.status)
              changed = mergeStats(obj.status.objectId, obj.objectType, obj.status.stats) || changed
          }
          // Objects that have left view/the instance: drop their records so the
          // roster (e.g. the Instance panel) reflects players leaving, not just
          // joining. If the local player themselves drops, forget their id too.
          for (const droppedId of data?.drops ?? []) {
            if (recordsRef.current.delete(droppedId)) {
              if (localPlayerRef.current === droppedId) localPlayerRef.current = null
              changed = true
            }
          }
        } else if (env.type === 'NewTickPacket') {
          const nt = env.data as {
            status?: Array<{ objectId: number; stats?: StatEntry[] }>
          } | null
          for (const st of nt?.status ?? [])
            changed = mergeStats(st.objectId, undefined, st.stats) || changed
        } else if (env.type === 'CreateSuccessPacket') {
          const id = (env.data as { objectId?: number } | null)?.objectId
          // Guard on an actual change: EnemyHitPacket below arrives every hit, so
          // only flag when the local-player id is first resolved or changes.
          if (typeof id === 'number' && id > 0 && localPlayerRef.current !== id) {
            localPlayerRef.current = id
            changed = true
          }
        } else if (env.type === 'EnemyHitPacket') {
          const main = (env.data as { mainID?: number } | null)?.mainID
          if (typeof main === 'number' && main > 0 && localPlayerRef.current !== main) {
            localPlayerRef.current = main
            changed = true
          }
        } else if (env.type === 'MapInfoPacket') {
          clear()
        }
      }
      if (changed) scheduleNotify()
    })
    const offDetach = window.overlay.onOverlayDetach(clear)
    return () => {
      offBatch()
      offDetach()
    }
  }, [])

  const objectType = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null
        ? null
        : (recordsRef.current.get(objectId)?.objectType ??
          lastObjectTypeRef.current.get(objectId) ??
          null),
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
  const equipmentRarity = useCallback(
    (objectId: number | null | undefined): number[] | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.equipmentRarity ?? null),
    []
  )
  const name = useCallback(
    (objectId: number | null | undefined): string | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.name ?? null),
    []
  )
  const clothingDye = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.clothingDye ?? null),
    []
  )
  const accessoryDye = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null ? null : (recordsRef.current.get(objectId)?.accessoryDye ?? null),
    []
  )
  const characters = useCallback((): number[] => {
    const ids: number[] = []
    for (const [id, rec] of recordsRef.current) {
      // Players carry a username AND broadcast their equipment (INVENTORY_0..3).
      // Portals / NPCs / pets can have a NAME_STAT but no equipment, so requiring
      // both filters the roster down to actual players.
      if (rec.name != null && rec.name !== '' && rec.equipment != null) ids.push(id)
    }
    return ids
  }, [])
  const localPlayerId = useCallback((): number | null => localPlayerRef.current, [])

  return (
    <EntityContext.Provider
      value={{
        objectType,
        skin,
        equipment,
        equipmentRarity,
        clothingDye,
        accessoryDye,
        name,
        characters,
        localPlayerId,
        subscribe
      }}
    >
      {children}
    </EntityContext.Provider>
  )
}
