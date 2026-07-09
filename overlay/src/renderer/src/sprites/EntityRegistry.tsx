import { useCallback, useEffect, useRef } from 'react'
import type { PacketEnvelope } from '../../../shared/ipc'
import { EntityContext } from './context'

interface UpdateData {
  newObjects?: Array<{ objectType: number; status?: { objectId: number } }>
}

/**
 * App-level registry of objectId -> objectType, built from the packet stream so
 * any panel (DPS, a future character/party panel, etc.) can resolve an entity
 * to its sprite. Kept in a ref (no re-render per packet); consumers read it
 * during their own render cycle. Cleared on map change / overlay detach.
 */
export function EntityRegistryProvider({
  children
}: {
  children: React.ReactNode
}): React.JSX.Element {
  const typesRef = useRef<Map<number, number>>(new Map())

  useEffect(() => {
    const offBatch = window.overlay.onPacketBatch((packets: PacketEnvelope[]) => {
      for (const env of packets) {
        if (env.type === 'UpdatePacket') {
          const data = env.data as UpdateData | null
          for (const obj of data?.newObjects ?? []) {
            if (obj?.status) typesRef.current.set(obj.status.objectId, obj.objectType)
          }
        } else if (env.type === 'MapInfoPacket') {
          typesRef.current.clear()
        }
      }
    })
    const offDetach = window.overlay.onOverlayDetach(() => typesRef.current.clear())
    return () => {
      offBatch()
      offDetach()
    }
  }, [])

  const objectType = useCallback(
    (objectId: number | null | undefined): number | null =>
      objectId == null ? null : (typesRef.current.get(objectId) ?? null),
    []
  )

  return <EntityContext.Provider value={{ objectType }}>{children}</EntityContext.Provider>
}
