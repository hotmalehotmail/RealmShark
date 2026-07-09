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

/**
 * packets/incoming/ServerPlayerShootPacket.java: fired whenever any entity
 * (a real player, or a summoned pet/minion/trap acting on a player's behalf)
 * shoots. ownerId is the entity actually doing the shooting; summonerId (0 if
 * absent) is the player who owns it, when it's a summon rather than a direct
 * player shot. This is how DamagePacket.objectId for a pet/minion hit gets
 * redirected to the owning player instead of showing up as an unknown id.
 */
export interface ServerPlayerShootPacketData {
  ownerId: number
  summonerId: number
}

export interface PlayerDps {
  objectId: number
  name: string
  damage: number
  dps: number
}
