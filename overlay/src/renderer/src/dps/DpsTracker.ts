import type { PacketEnvelope } from '../../../shared/ipc'
import {
  NAME_STAT_TYPE_NUM,
  type CreateSuccessPacketData,
  type DamagePacketData,
  type PlayerDps,
  type UpdatePacketData
} from './types'

const WINDOW_MS = 8000

interface HitEvent {
  time: number
  damage: number
}

export interface DpsSnapshot {
  /** The enemy the local player last hit, or null if we haven't seen them hit anything yet. */
  targetId: number | null
  targetName: string
  /** Per-attacker DPS against that target, sorted descending. */
  rows: PlayerDps[]
}

export const EMPTY_SNAPSHOT: DpsSnapshot = { targetId: null, targetName: '', rows: [] }

/**
 * Tracks damage-per-second per enemy target, focused on whichever enemy the
 * local player last hit. Reset on instance change (MapInfoPacket) and meant to
 * also be reset externally when the game closes (electron-overlay-window's
 * "detach" event) - both wipe the same state, just triggered from different
 * places.
 */
export class DpsTracker {
  private entityNames = new Map<number, string>()
  private targets = new Map<number, Map<number, HitEvent[]>>()
  private focusTargetId: number | null = null
  private localPlayerId: number | null = null

  ingest(packets: PacketEnvelope[]): void {
    for (const envelope of packets) {
      switch (envelope.type) {
        case 'CreateSuccessPacket':
          this.localPlayerId = (envelope.data as CreateSuccessPacketData).objectId
          break
        case 'MapInfoPacket':
          this.reset()
          break
        case 'UpdatePacket':
          this.ingestUpdate(envelope.data as UpdatePacketData)
          break
        case 'DamagePacket':
          this.ingestDamage(envelope.data as DamagePacketData, envelope.time)
          break
        default:
          break
      }
    }
  }

  private ingestUpdate(data: UpdatePacketData): void {
    for (const obj of data.newObjects ?? []) {
      const nameStat = obj.status?.stats?.find((s) => s.statTypeNum === NAME_STAT_TYPE_NUM)
      if (nameStat?.stringStatValue) {
        this.entityNames.set(obj.status.objectId, nameStat.stringStatValue)
      }
    }
  }

  private ingestDamage(data: DamagePacketData, time: number): void {
    let byAttacker = this.targets.get(data.targetId)
    if (!byAttacker) {
      byAttacker = new Map()
      this.targets.set(data.targetId, byAttacker)
    }
    let buffer = byAttacker.get(data.objectId)
    if (!buffer) {
      buffer = []
      byAttacker.set(data.objectId, buffer)
    }
    buffer.push({ time, damage: data.damageAmount })

    if (this.localPlayerId !== null && data.objectId === this.localPlayerId) {
      this.focusTargetId = data.targetId
    }
  }

  /** Wipe all tracked state - call on instance change (handled internally) or the game closing. */
  reset(): void {
    this.entityNames.clear()
    this.targets.clear()
    this.focusTargetId = null
    this.localPlayerId = null
  }

  snapshot(nowMs: number, windowMs: number = WINDOW_MS): DpsSnapshot {
    if (this.focusTargetId === null) {
      return EMPTY_SNAPSHOT
    }

    const byAttacker = this.targets.get(this.focusTargetId)
    const targetName = this.nameOf(this.focusTargetId)
    if (!byAttacker) {
      return { targetId: this.focusTargetId, targetName, rows: [] }
    }

    const cutoff = nowMs - windowMs
    const windowSeconds = windowMs / 1000
    const rows: PlayerDps[] = []

    for (const [attackerId, buffer] of byAttacker) {
      // Trim in place so the buffer doesn't grow unbounded across many recomputes.
      while (buffer.length > 0 && buffer[0].time < cutoff) {
        buffer.shift()
      }
      if (buffer.length === 0) continue

      const damage = buffer.reduce((sum, hit) => sum + hit.damage, 0)
      rows.push({
        objectId: attackerId,
        name: this.nameOf(attackerId),
        damage,
        dps: damage / windowSeconds
      })
    }

    rows.sort((a, b) => b.dps - a.dps)

    return { targetId: this.focusTargetId, targetName, rows }
  }

  private nameOf(id: number): string {
    return this.entityNames.get(id) ?? `#${id}`
  }
}
