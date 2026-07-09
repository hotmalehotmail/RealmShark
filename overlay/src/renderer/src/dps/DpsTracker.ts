import type { PacketEnvelope } from '../../../shared/ipc'
import {
  NAME_STAT_TYPE_NUM,
  type CreateSuccessPacketData,
  type DamagePacketData,
  type PlayerDps,
  type ServerPlayerShootPacketData,
  type UpdatePacketData
} from './types'

const WINDOW_MS = 8000

/**
 * Flip to false to silence the [dps] diagnostic logging (per-type packet
 * counts, one-time field-key dumps, focus/local-player transitions, and the
 * periodic state summary emitted from useDpsTracker). On while we're chasing
 * "no DPS data with real game traffic" - the logs surface in the Console panel.
 */
export const DPS_DEBUG = true

/** Packet types the tracker actually consumes - the summary reports these explicitly. */
const RELEVANT_TYPES = [
  'CreateSuccessPacket',
  'MapInfoPacket',
  'UpdatePacket',
  'ServerPlayerShootPacket',
  'DamagePacket'
] as const

function dlog(...args: unknown[]): void {
  if (DPS_DEBUG) console.log('[dps]', ...args)
}

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
  /** Summoned entity id -> owning player id, from ServerPlayerShootPacket. */
  private minionOwners = new Map<number, number>()
  /** Debug: how many of each packet type we've ingested (all types, not just relevant ones). */
  private typeCounts = new Map<string, number>()
  /** Debug: types whose field keys we've already dumped once (to avoid per-packet spam). */
  private dumpedKeys = new Set<string>()

  ingest(packets: PacketEnvelope[]): void {
    for (const envelope of packets) {
      if (DPS_DEBUG) this.countAndDump(envelope)
      switch (envelope.type) {
        case 'CreateSuccessPacket': {
          this.localPlayerId = (envelope.data as CreateSuccessPacketData).objectId
          dlog('local player id =', this.localPlayerId)
          break
        }
        case 'MapInfoPacket':
          dlog('MapInfoPacket -> reset (instance change)')
          this.reset()
          break
        case 'UpdatePacket':
          this.ingestUpdate(envelope.data as UpdatePacketData)
          break
        case 'ServerPlayerShootPacket':
          this.ingestShoot(envelope.data as ServerPlayerShootPacketData)
          break
        case 'DamagePacket':
          this.ingestDamage(envelope.data as DamagePacketData, envelope.time)
          break
        default:
          break
      }
    }
  }

  /**
   * Debug helper: tally every packet type and, the first time we see one of
   * the DPS-relevant types, dump its field keys + a sample. A wire-format
   * mismatch (a Java field renamed, or the wrong nesting) shows up here as
   * `undefined` sample values or unexpected keys - the fastest way to spot
   * why damage isn't being counted with real traffic.
   */
  private countAndDump(envelope: PacketEnvelope): void {
    this.typeCounts.set(envelope.type, (this.typeCounts.get(envelope.type) ?? 0) + 1)
    if (
      (RELEVANT_TYPES as readonly string[]).includes(envelope.type) &&
      !this.dumpedKeys.has(envelope.type)
    ) {
      this.dumpedKeys.add(envelope.type)
      const data = envelope.data as Record<string, unknown> | null
      dlog(`first ${envelope.type}: keys=[${data ? Object.keys(data).join(',') : ''}]`, data)
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

  private ingestShoot(data: ServerPlayerShootPacketData): void {
    // summonerId is 0 for a direct player shot (no summon involved) - only
    // pets/minions/traps acting on a player's behalf carry a nonzero owner.
    if (data.summonerId !== 0) {
      this.minionOwners.set(data.ownerId, data.summonerId)
    }
  }

  private ingestDamage(data: DamagePacketData, time: number): void {
    // Redirect a pet/minion/trap's hit to the player who owns it, so their
    // damage isn't attributed to an anonymous entity id.
    const attackerId = this.minionOwners.get(data.objectId) ?? data.objectId

    let byAttacker = this.targets.get(data.targetId)
    if (!byAttacker) {
      byAttacker = new Map()
      this.targets.set(data.targetId, byAttacker)
    }
    let buffer = byAttacker.get(attackerId)
    if (!buffer) {
      buffer = []
      byAttacker.set(attackerId, buffer)
    }
    buffer.push({ time, damage: data.damageAmount })

    if (DPS_DEBUG && !Number.isFinite(data.damageAmount)) {
      // damageAmount arriving as undefined/NaN means the field name doesn't
      // match the wire format - a prime suspect for "rows show up but read 0".
      dlog('WARNING damageAmount is not finite:', data.damageAmount, 'raw:', data)
    }

    if (this.localPlayerId !== null && attackerId === this.localPlayerId) {
      if (this.focusTargetId !== data.targetId) {
        dlog('focus target ->', data.targetId, `(${this.nameOf(data.targetId)})`)
      }
      this.focusTargetId = data.targetId
    }
  }

  /** Wipe all tracked state - call on instance change (handled internally) or the game closing. */
  reset(): void {
    this.entityNames.clear()
    this.targets.clear()
    this.focusTargetId = null
    this.localPlayerId = null
    this.minionOwners.clear()
    // Deliberately keep typeCounts/dumpedKeys across resets so the running
    // totals (and one-time key dumps) survive instance changes - they describe
    // the whole session's traffic, not a single instance.
  }

  /**
   * One-line snapshot of internal state + per-type packet tallies, for the
   * periodic diagnostic log. `focus=null` after `DamagePacket>0` means damage
   * is flowing but none of it was attributed to the local player (local id
   * never resolved, or attribution/field mismatch); `DamagePacket=0` means no
   * damage is reaching the tracker at all.
   */
  debugSummary(): string {
    const counts = RELEVANT_TYPES.map((t) => `${t}=${this.typeCounts.get(t) ?? 0}`).join(' ')
    let total = 0
    for (const n of this.typeCounts.values()) total += n
    return (
      `state[local=${this.localPlayerId} focus=${this.focusTargetId} ` +
      `targets=${this.targets.size} names=${this.entityNames.size}] ` +
      `pkts[total=${total} ${counts}]`
    )
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
