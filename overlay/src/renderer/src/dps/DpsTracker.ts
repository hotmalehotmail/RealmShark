import type { PacketEnvelope } from '../../../shared/ipc'
import {
  NAME_STAT_TYPE_NUM,
  type BridgeDpsData,
  type CreateSuccessPacketData,
  type DamagePacketData,
  type EnemyHitPacketData,
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
  'EnemyHitPacket',
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
 *
 * The local player's objectId is resolved from two sources: CreateSuccessPacket
 * (authoritative but sent only once, at map load - missed if we attach
 * mid-instance) and EnemyHitPacket.mainID (an outgoing packet emitted on every
 * one of our hits, so it re-establishes identity continuously). The latter is
 * what makes DPS work when the sniffer attaches after the player is already
 * in-game; see ingestEnemyHit.
 */
export class DpsTracker {
  private entityNames = new Map<number, string>()
  /** Enemy/NPC id -> name, resolved bridge-side from game assets (objectNames envelope). */
  private objectNames = new Map<number, string>()
  /** Bridge-computed DPS, per enemy id -> { name, rows }. Replaces the local DamagePacket estimate. */
  private bridgeEnemies = new Map<number, { name: string; rows: PlayerDps[] }>()
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
          dlog('local player id =', this.localPlayerId, '(from CreateSuccessPacket)')
          break
        }
        case 'MapInfoPacket':
          dlog('MapInfoPacket -> reset (instance change)')
          this.reset()
          break
        case 'UpdatePacket':
          this.ingestUpdate(envelope.data as UpdatePacketData)
          break
        case 'objectNames':
          this.ingestObjectNames(envelope.data as Record<string, string>)
          break
        case 'dps':
          this.ingestBridgeDps(envelope.data as BridgeDpsData)
          break
        case 'ServerPlayerShootPacket':
          this.ingestShoot(envelope.data as ServerPlayerShootPacketData)
          break
        case 'EnemyHitPacket':
          this.ingestEnemyHit(envelope.data as EnemyHitPacketData)
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

  /**
   * Enemy/NPC names resolved bridge-side from the game's assets (keyed by
   * objectId as a string on the wire). Players are named via NAME_STAT instead,
   * which nameOf() prefers, so these never override a real player name.
   */
  private ingestObjectNames(data: Record<string, string>): void {
    let added = 0
    for (const [id, name] of Object.entries(data)) {
      const objectId = Number(id)
      if (Number.isFinite(objectId) && !this.objectNames.has(objectId)) {
        this.objectNames.set(objectId, name)
        added++
      }
    }
    if (added > 0) dlog('resolved', added, 'object name(s), e.g.', Object.values(data)[0])
  }

  /**
   * Bridge-computed DPS snapshot: the Java DpsEngine already did the real
   * damage math (weapon/ability/crucible) and per-player attribution, so we
   * just index it by enemy id for snapshot() to look up the focused target.
   */
  private ingestBridgeDps(data: BridgeDpsData): void {
    this.bridgeEnemies.clear()
    for (const enemy of data.enemies ?? []) {
      const rows: PlayerDps[] = (enemy.players ?? []).map((p) => ({
        objectId: p.id,
        // Prefer the player's NAME_STAT username we saw in the stream. The
        // bridge falls back to the class name (IdToAsset.objectName) whenever a
        // player entity is missing NAME_STAT, so `p.name` can be e.g. "Wizard"
        // instead of the username - our entityNames map is authoritative here.
        name: this.entityNames.get(p.id) ?? p.name,
        damage: p.damage,
        dps: p.dps
      }))
      this.bridgeEnemies.set(enemy.id, { name: enemy.name, rows })
    }
    if (data.enemies?.length) {
      const e = data.enemies[0]
      dlog(
        'bridge dps: enemies=',
        data.enemies.length,
        `e.g. ${e.name} (${e.players?.length ?? 0} players)`
      )
    }
  }

  private ingestShoot(data: ServerPlayerShootPacketData): void {
    // summonerId is 0 for a direct player shot (no summon involved) - only
    // pets/minions/traps acting on a player's behalf carry a nonzero owner.
    if (data.summonerId !== 0) {
      this.minionOwners.set(data.ownerId, data.summonerId)
    }
  }

  /**
   * The local player hit an enemy (outgoing packet, so this fires only on our
   * own machine). `mainID` is the local player - a live, continuously-emitted
   * identity signal that works even when we attached mid-instance and never
   * saw the one-shot CreateSuccessPacket. `targetId` is what we're currently
   * attacking, so it also gives us the focus target directly, without having
   * to wait for a DamagePacket to match our (possibly still-unknown) id.
   */
  private ingestEnemyHit(data: EnemyHitPacketData): void {
    // Prefer mainID (always the player, even for pet/minion hits); fall back to
    // shooterID if a client build ever sends mainID as 0/absent.
    const playerId = Number.isFinite(data.mainID) && data.mainID > 0 ? data.mainID : data.shooterID
    if (Number.isFinite(playerId) && playerId > 0 && playerId !== this.localPlayerId) {
      dlog('local player id =', playerId, '(from EnemyHitPacket)')
      this.localPlayerId = playerId
    }
    if (Number.isFinite(data.targetId) && this.focusTargetId !== data.targetId) {
      dlog(
        'focus target ->',
        data.targetId,
        `(${this.nameOf(data.targetId)}) (from EnemyHitPacket)`
      )
      this.focusTargetId = data.targetId
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
    this.objectNames.clear()
    this.bridgeEnemies.clear()
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

    // Prefer the bridge's authoritative computed DPS for the focused enemy (it
    // includes the local player's own damage, which the packet stream alone
    // can't provide). Its own resolved enemy name wins over our id fallback.
    const bridge = this.bridgeEnemies.get(this.focusTargetId)
    if (bridge) {
      return {
        targetId: this.focusTargetId,
        targetName: bridge.name || this.nameOf(this.focusTargetId),
        rows: bridge.rows
      }
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
    // Player NAME_STAT wins over an asset-resolved name (a player object also
    // has an objectType); enemies only have the latter; else fall back to id.
    return this.entityNames.get(id) ?? this.objectNames.get(id) ?? `#${id}`
  }
}
