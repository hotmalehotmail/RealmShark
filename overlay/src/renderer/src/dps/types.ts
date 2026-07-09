/**
 * Shapes of the packet fields we care about, as serialized by the Java
 * bridge's PacketSerializer (Gson reflects Java field names verbatim).
 * See packets/incoming/DamagePacket.java and packets/incoming/UpdatePacket.java.
 */

export interface DamagePacketData {
  targetId: number
  damageAmount: number
  objectId: number
  bulletId: number
}

export interface StatData {
  statTypeNum: number
  statType?: string
  statValue?: number
  stringStatValue?: string
  statValueTwo?: number
}

/** packets/data/enums/StatType.java: NAME_STAT(31) */
export const NAME_STAT_TYPE_NUM = 31

export interface ObjectStatusData {
  objectId: number
  stats: StatData[]
}

export interface ObjectData {
  objectType: number
  status: ObjectStatusData
}

export interface UpdatePacketData {
  newObjects: ObjectData[]
}

/** packets/incoming/CreateSuccessPacket.java: server's own confirmation of "you are this objectId". */
export interface CreateSuccessPacketData {
  objectId: number
}

export interface PlayerDps {
  objectId: number
  name: string
  damage: number
  dps: number
}
