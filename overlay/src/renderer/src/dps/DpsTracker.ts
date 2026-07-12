import type { PacketEnvelope } from '../../../shared/ipc'
import {
  MAX_HP_STAT_TYPE_NUM,
  NAME_STAT_TYPE_NUM,
  type BridgeDpsData,
  type CreateSuccessPacketData,
  type DamagePacketData,
  type EnemyHitPacketData,
  type MapInfoPacketData,
  type PlayerDps,
  type QuestObjectIdPacketData,
  type ServerPlayerShootPacketData,
  type UpdatePacketData
} from './types'

const WINDOW_MS = 8000

/** packets/data/enums/StatType.java: the stats a player's cosmetic loadout is carried on. */
const SKIN_ID_STAT_TYPE_NUM = 25
const INVENTORY_0_STAT_TYPE_NUM = 8
const CLOTHING_DYE_STAT_TYPE_NUM = 32
const ACCESSORY_DYE_STAT_TYPE_NUM = 33

/** A player's cosmetic loadout, frozen into history at the moment their instance ends. */
export interface PlayerCosmetics {
  objectType: number
  skin?: number
  /** 4 equipped slots (INVENTORY_0..3). Empty slots are `<= 0`. */
  equipment?: number[]
  clothingDye?: number
  accessoryDye?: number
}

/** One enemy's frozen final damage breakdown, retained in a `DpsHistoryEntry`. */
export interface DpsHistoryEnemy {
  id: number
  name: string
  /** The enemy's own objectType, for the master-list icon fallback (main-boss sprite). */
  objectType: number | null
  players: PlayerDps[]
  /** Frozen cosmetics per player objectId, so the detail view renders correctly even after the live EntityRegistry has moved on to a later instance. */
  cosmetics: Map<number, PlayerCosmetics>
}

/** A past instance's retained damage summary - the DPS summary panel's master-list row + detail source. */
export interface DpsHistoryEntry {
  id: string
  instanceName: string
  /** Wall-clock ms (Date.now()) when the instance ended. */
  endedAt: number
  localPlayerId: number | null
  /** Enemies ranked by total damage absorbed, descending; boss phases already merged. */
  enemies: DpsHistoryEnemy[]
}

/** How many past instances to retain (session-scoped; oldest drops off). */
export const HISTORY_MAX_INSTANCES = 20

/**
 * Minimum total damage a single enemy must have absorbed for the instance to
 * be logged - a proxy for "a boss-scale enemy was fought", so nexus/vault/
 * realm hops/rushed-empty rooms don't clutter the history. An instance where a
 * quest objective (the game's own boss marker) was engaged at all is logged
 * regardless of this threshold, even if the fight was cut short.
 */
export const HISTORY_LOG_MIN_DAMAGE = 5000

/**
 * Flip to false to silence the [dps] diagnostic logging (per-type packet
 * counts, one-time field-key dumps, focus/local-player transitions, and the
 * periodic state summary emitted from useDpsTracker). On while we're chasing
 * "no DPS data with real game traffic" - the logs surface in the Console panel.
 */
export const DPS_DEBUG = false

/** Packet types the tracker actually consumes - the summary reports these explicitly. */
const RELEVANT_TYPES = [
  'CreateSuccessPacket',
  'MapInfoPacket',
  'UpdatePacket',
  'ServerPlayerShootPacket',
  'EnemyHitPacket',
  'DamagePacket',
  'QuestObjectIdPacket'
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
 * Tracks damage-per-second per enemy target. When a quest objective is active
 * (QuestObjectIdPacket - the game's own boss/objective marker in a dungeon),
 * focus locks onto that entity and stays there ("sticky") even while AoEing
 * other enemies, only moving when the locked target dies/despawns or a new
 * quest objective is set - a boss phase change re-points the objective at the
 * next phase's objectId, and the prior phase's per-player damage is carried
 * forward so the total doesn't reset. Outside a quest objective (e.g. open
 * world) it falls back to focusing whichever enemy the local player last hit.
 * Reset on instance change (MapInfoPacket) and meant to also be reset
 * externally when the game closes (electron-overlay-window's "detach" event) -
 * both wipe the same state, just triggered from different places.
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
  /** Enemy/NPC id -> MAX_HP_STAT, from UpdatePacket - used only for the fallback last-hit preference below. */
  private enemyMaxHp = new Map<number, number>()
  /**
   * The current quest-objective entity id (QuestObjectIdPacket.objectId), or
   * null when no quest objective is active (open world - fallback to last-hit).
   * Non-null gates focusTargetId against last-hit updates (sticky boss lock).
   */
  private lockedBossId: number | null = null
  /** Whether `lockedBossId`'s entity is still alive - false once it dies/despawns, until a new objective re-locks. */
  private bossAlive = false
  /**
   * Per-attacker damage carried forward from earlier phases of the current
   * boss lock (keyed by attacker objectId), accumulated in carryForwardBossDamage
   * whenever the quest objective moves to a new objectId while one was already
   * locked. snapshot() adds this on top of the current phase's live rows so a
   * boss's total doesn't reset across a phase/form change.
   */
  private bossCarry = new Map<number, { name: string; damage: number }>()
  /** Debug: how many of each packet type we've ingested (all types, not just relevant ones). */
  private typeCounts = new Map<string, number>()
  /** Debug: types whose field keys we've already dumped once (to avoid per-packet spam). */
  private dumpedKeys = new Set<string>()

  /** objectId -> objectType, for every object seen this instance (players and enemies alike). */
  private objectTypes = new Map<number, number>()
  /** Player objectId -> cosmetic loadout, built up from UpdatePacket the same way EntityRegistry does - kept local (rather than read live from EntityRegistry) so a retained history entry's per-player sprite/gear stays correct after the live registry clears on the next instance change. */
  private playerCosmetics = new Map<number, PlayerCosmetics>()
  /** The current instance's display name (MapInfoPacket.displayName), captured for the *next* instance-end snapshot. */
  private currentInstanceName = ''
  /** Every quest-objective objectId seen locked this instance (all phases, including the current one) - lets the history snapshot collapse them into one merged boss entry instead of listing each phase separately. */
  private bossPhaseIds = new Set<number>()
  /** Retained past-instance summaries, newest first. Session-scoped: survives `reset()`, only cleared by a fresh page load. */
  private history: DpsHistoryEntry[] = []
  private historySeq = 0

  ingest(packets: PacketEnvelope[]): void {
    for (const envelope of packets) {
      if (DPS_DEBUG) this.countAndDump(envelope)
      switch (envelope.type) {
        case 'CreateSuccessPacket': {
          this.localPlayerId = (envelope.data as CreateSuccessPacketData).objectId
          dlog('local player id =', this.localPlayerId, '(from CreateSuccessPacket)')
          break
        }
        case 'MapInfoPacket': {
          dlog('MapInfoPacket -> reset (instance change)')
          this.retainInstanceIfQualifying()
          this.reset()
          const mapInfo = envelope.data as MapInfoPacketData | null
          this.currentInstanceName = mapInfo?.displayName ?? ''
          break
        }
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
        case 'QuestObjectIdPacket':
          this.ingestQuestObjectId(envelope.data as QuestObjectIdPacketData)
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
      if (!obj.status) continue
      const objectId = obj.status.objectId
      this.objectTypes.set(objectId, obj.objectType)
      const nameStat = obj.status.stats?.find((s) => s.statTypeNum === NAME_STAT_TYPE_NUM)
      if (nameStat?.stringStatValue) {
        // NAME_STAT is "username,titleCode,...": keep only the username. This
        // entityNames entry overrides the bridge's p.name below, so it must be
        // stripped here too (the bridge already strips its own copy).
        this.entityNames.set(objectId, nameStat.stringStatValue.split(',')[0])
      }
      const maxHpStat = obj.status.stats?.find((s) => s.statTypeNum === MAX_HP_STAT_TYPE_NUM)
      if (maxHpStat?.statValue !== undefined) {
        this.enemyMaxHp.set(objectId, maxHpStat.statValue)
      }
      this.mergeCosmetics(objectId, obj.objectType, obj.status.stats)
    }
    // An entity leaving view covers both despawn (killed) and the game simply
    // no longer rendering it - either way, if it's our locked boss target we
    // can no longer assume it's alive; see onBossDespawn.
    for (const dropId of data.drops ?? []) {
      this.onBossDespawn(dropId)
    }
  }

  /**
   * Merges a player's cosmetic loadout (skin/equipment/dyes) from a stat
   * delta, mirroring EntityRegistry's own merge - kept as a local, frozen-at-
   * retention-time copy (see `playerCosmetics`) rather than a live lookup, so
   * a retained history entry's sprite/gear survive the live registry clearing
   * on the next instance change.
   */
  private mergeCosmetics(
    objectId: number,
    objectType: number,
    stats?: { statTypeNum: number; statValue?: number }[]
  ): void {
    if (!stats || stats.length === 0) return
    let rec = this.playerCosmetics.get(objectId)
    for (const s of stats) {
      if (s.statTypeNum === SKIN_ID_STAT_TYPE_NUM && s.statValue !== undefined) {
        rec = rec ?? { objectType }
        rec.skin = s.statValue
      } else if (
        s.statTypeNum >= INVENTORY_0_STAT_TYPE_NUM &&
        s.statTypeNum <= INVENTORY_0_STAT_TYPE_NUM + 3 &&
        s.statValue !== undefined
      ) {
        rec = rec ?? { objectType }
        if (!rec.equipment) rec.equipment = [-1, -1, -1, -1]
        rec.equipment[s.statTypeNum - INVENTORY_0_STAT_TYPE_NUM] = s.statValue
      } else if (s.statTypeNum === CLOTHING_DYE_STAT_TYPE_NUM && s.statValue !== undefined) {
        rec = rec ?? { objectType }
        rec.clothingDye = s.statValue
      } else if (s.statTypeNum === ACCESSORY_DYE_STAT_TYPE_NUM && s.statValue !== undefined) {
        rec = rec ?? { objectType }
        rec.accessoryDye = s.statValue
      }
    }
    if (rec) {
      rec.objectType = objectType
      this.playerCosmetics.set(objectId, rec)
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
    if (Number.isFinite(data.targetId)) {
      this.onLocalHit(data.targetId)
      // `kill` is only set on the hit that actually finishes the target off -
      // a direct, immediate despawn signal for whoever gets the killing blow.
      if (data.kill) this.onBossDespawn(data.targetId)
    }
  }

  /**
   * The local player's shot/damage landed on `targetId`. While a quest
   * objective is locked and still alive, this is ignored entirely - AoEing
   * adds must not steal focus from the boss (issue: sticky DPS focus). Once
   * that lock ends (no objective, or the locked target died/despawned), this
   * drives the last-hit fallback focus.
   */
  private onLocalHit(targetId: number): void {
    if (this.lockedBossId !== null && this.bossAlive) return
    this.maybeSwitchFallbackFocus(targetId)
  }

  /**
   * Last-hit fallback focus, with one refinement over pure last-hit: don't let
   * a hit on a smaller add steal focus away from a bigger enemy already being
   * fought, whenever both max-HPs are actually known (from UpdatePacket's
   * MAX_HP_STAT - never a new bridge dependency). Falls straight through to
   * plain last-hit whenever HP is unknown for either side, which is the common
   * case, so default behavior is unchanged from before this feature.
   */
  private maybeSwitchFallbackFocus(newTargetId: number): void {
    if (this.focusTargetId === newTargetId) return
    if (this.focusTargetId !== null) {
      const currentMax = this.enemyMaxHp.get(this.focusTargetId)
      const newMax = this.enemyMaxHp.get(newTargetId)
      if (currentMax !== undefined && newMax !== undefined && currentMax > newMax) {
        return
      }
    }
    dlog('focus target ->', newTargetId, `(${this.nameOf(newTargetId)}) (from last hit)`)
    this.focusTargetId = newTargetId
  }

  /**
   * The current quest objective changed (QuestObjectIdPacket.objectId) - the
   * game's own boss/objective marker, e.g. a dungeon's main boss. Locks DPS
   * focus onto it (sticky - see onLocalHit) and, if a boss was already locked,
   * carries its accumulated per-player damage forward so a phase/form change
   * (a new objectId) doesn't reset the fight's total.
   */
  private ingestQuestObjectId(data: QuestObjectIdPacketData): void {
    const newId = data.objectId
    if (!Number.isFinite(newId) || newId <= 0 || newId === this.lockedBossId) return
    if (this.lockedBossId !== null) {
      this.carryForwardBossDamage(this.lockedBossId)
      this.bossPhaseIds.add(this.lockedBossId)
    }
    dlog('quest objective ->', newId, `(${this.nameOf(newId)}) - locking DPS focus`)
    this.lockedBossId = newId
    this.bossAlive = true
    this.focusTargetId = newId
    this.bossPhaseIds.add(newId)
  }

  /**
   * The locked boss target died/despawned (a kill on it, or it left view via
   * UpdatePacket.drops). Only marks it no-longer-alive - it does NOT clear
   * focusTargetId, so the panel keeps showing the final numbers until either a
   * new quest objective re-locks (phase transition) or the next hit elsewhere
   * moves focus via the last-hit fallback (see onLocalHit).
   */
  private onBossDespawn(id: number): void {
    if (this.lockedBossId === id) {
      this.bossAlive = false
    }
  }

  /** Snapshot `oldId`'s current per-player damage into `bossCarry`, summing across phases. */
  private carryForwardBossDamage(oldId: number): void {
    for (const [attackerId, row] of this.totalDamageRows(oldId)) {
      const existing = this.bossCarry.get(attackerId)
      if (existing) {
        existing.damage += row.damage
        if (row.name) existing.name = row.name
      } else {
        this.bossCarry.set(attackerId, { name: row.name, damage: row.damage })
      }
    }
  }

  /** Per-attacker cumulative damage against `targetId` - bridge rows (authoritative) if present, else the local buffer. */
  private totalDamageRows(targetId: number): Map<number, { name: string; damage: number }> {
    const result = new Map<number, { name: string; damage: number }>()
    const bridge = this.bridgeEnemies.get(targetId)
    if (bridge) {
      for (const row of bridge.rows)
        result.set(row.objectId, { name: row.name, damage: row.damage })
      return result
    }
    const byAttacker = this.targets.get(targetId)
    if (byAttacker) {
      for (const [attackerId, buffer] of byAttacker) {
        const damage = buffer.reduce((sum, hit) => sum + hit.damage, 0)
        result.set(attackerId, { name: this.nameOf(attackerId), damage })
      }
    }
    return result
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
      this.onLocalHit(data.targetId)
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
    this.enemyMaxHp.clear()
    this.lockedBossId = null
    this.bossAlive = false
    this.bossCarry.clear()
    this.objectTypes.clear()
    this.playerCosmetics.clear()
    this.bossPhaseIds.clear()
    // Deliberately keep typeCounts/dumpedKeys across resets so the running
    // totals (and one-time key dumps) survive instance changes - they describe
    // the whole session's traffic, not a single instance. Likewise `history`/
    // `historySeq`/`currentInstanceName` are session-scoped, not per-instance -
    // see retainInstanceIfQualifying, called just before reset() on every
    // MapInfoPacket.
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
      `bossLock=${this.lockedBossId}(alive=${this.bossAlive}) ` +
      `targets=${this.targets.size} names=${this.entityNames.size}] ` +
      `pkts[total=${total} ${counts}]`
    )
  }

  snapshot(nowMs: number, windowMs: number = WINDOW_MS): DpsSnapshot {
    if (this.focusTargetId === null) {
      return EMPTY_SNAPSHOT
    }

    // Mid (or just past) a sticky boss lock with carried-forward damage from an
    // earlier phase: merge that carry with the current phase's live rows so the
    // fight's total spans the whole encounter, not just the latest objectId.
    if (this.bossCarry.size > 0 && this.focusTargetId === this.lockedBossId) {
      return this.bossSnapshot(nowMs, windowMs)
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

    // Sort by cumulative damage (not rolling dps) to match the bridge path
    // above and the ranking the DPS panel displays.
    rows.sort((a, b) => b.damage - a.damage)

    return { targetId: this.focusTargetId, targetName, rows }
  }

  /**
   * Same shape as `snapshot`, but for the locked boss target once a phase
   * transition has carried forward damage from an earlier phase into
   * `bossCarry`: adds each attacker's carry on top of the current phase's live
   * rows (bridge preferred, else the local rolling-window buffer), so `damage`
   * spans every phase seen so far while `dps` reflects the current phase's
   * live rate.
   */
  private bossSnapshot(nowMs: number, windowMs: number): DpsSnapshot {
    const targetId = this.lockedBossId as number
    const targetName = this.bridgeEnemies.get(targetId)?.name || this.nameOf(targetId)

    const merged = new Map<number, PlayerDps>()
    for (const [attackerId, carry] of this.bossCarry) {
      merged.set(attackerId, {
        objectId: attackerId,
        name: carry.name || this.nameOf(attackerId),
        damage: carry.damage,
        dps: 0
      })
    }

    const addLive = (attackerId: number, name: string, damage: number, dps: number): void => {
      const existing = merged.get(attackerId)
      if (existing) {
        existing.damage += damage
        existing.dps = dps
        if (name) existing.name = name
      } else {
        merged.set(attackerId, { objectId: attackerId, name, damage, dps })
      }
    }

    const bridge = this.bridgeEnemies.get(targetId)
    if (bridge) {
      for (const row of bridge.rows) addLive(row.objectId, row.name, row.damage, row.dps)
    } else {
      const byAttacker = this.targets.get(targetId)
      if (byAttacker) {
        const cutoff = nowMs - windowMs
        const windowSeconds = windowMs / 1000
        for (const [attackerId, buffer] of byAttacker) {
          while (buffer.length > 0 && buffer[0].time < cutoff) buffer.shift()
          if (buffer.length === 0) continue
          const damage = buffer.reduce((sum, hit) => sum + hit.damage, 0)
          addLive(attackerId, this.nameOf(attackerId), damage, damage / windowSeconds)
        }
      }
    }

    const rows = Array.from(merged.values()).sort((a, b) => b.damage - a.damage)
    return { targetId, targetName, rows }
  }

  private nameOf(id: number): string {
    // Player NAME_STAT wins over an asset-resolved name (a player object also
    // has an objectType); enemies only have the latter; else fall back to id.
    return this.entityNames.get(id) ?? this.objectNames.get(id) ?? `#${id}`
  }

  /**
   * Retained past-instance summaries, newest first (capped at
   * `HISTORY_MAX_INSTANCES`). Populated by `retainInstanceIfQualifying` on
   * every instance change; never mutated by `reset()`.
   */
  getHistory(): DpsHistoryEntry[] {
    return this.history
  }

  /**
   * Called on every MapInfoPacket, just before `reset()` wipes the live
   * state: if the instance about to end had a real fight (gated by
   * `HISTORY_LOG_MIN_DAMAGE`, or any quest objective engaged at all), freezes
   * its per-enemy damage breakdown into `history`. Nexus/vault/realm hops/
   * rushed-empty rooms fall under the threshold and are silently skipped.
   */
  private retainInstanceIfQualifying(): void {
    if (this.bridgeEnemies.size === 0 && this.lockedBossId === null) return

    const enemies = this.buildHistoryEnemies()
    if (enemies.length === 0) return

    const maxDamage = Math.max(...enemies.map((e) => totalDamage(e.players)))
    const bossEngaged = this.lockedBossId !== null
    if (maxDamage < HISTORY_LOG_MIN_DAMAGE && !bossEngaged) return

    this.historySeq += 1
    this.history.unshift({
      id: `${Date.now()}-${this.historySeq}`,
      instanceName: this.currentInstanceName || 'Unknown Instance',
      endedAt: Date.now(),
      localPlayerId: this.localPlayerId,
      enemies
    })
    if (this.history.length > HISTORY_MAX_INSTANCES) {
      this.history.length = HISTORY_MAX_INSTANCES
    }
  }

  /**
   * Builds the ranked, boss-phase-merged enemy list for a history snapshot.
   * `bridgeEnemies` holds one entry per raw objectId the bridge has ever seen
   * the local user hit this instance, including every phase of a boss whose
   * objectId changed form - those phase ids (`bossPhaseIds`) are excluded from
   * the flat per-enemy loop below and replaced with a single merged entry
   * (reusing `bossSnapshot`'s carry-forward merge, the same one the live panel
   * uses for a phase-changing boss - see docs/dps-engine.md's bossPhaseDamage
   * note for why that bridge-side field is NOT what does this merging).
   */
  private buildHistoryEnemies(): DpsHistoryEnemy[] {
    const enemies: DpsHistoryEnemy[] = []
    const mergedIds = new Set(this.bossPhaseIds)
    if (this.lockedBossId !== null) mergedIds.add(this.lockedBossId)

    for (const [id, enemy] of this.bridgeEnemies) {
      if (mergedIds.has(id)) continue
      if (totalDamage(enemy.rows) <= 0) continue
      enemies.push({
        id,
        name: enemy.name,
        objectType: this.objectTypes.get(id) ?? null,
        players: enemy.rows,
        cosmetics: this.cosmeticsFor(enemy.rows)
      })
    }

    if (this.lockedBossId !== null) {
      const merged = this.bossSnapshot(Date.now(), WINDOW_MS)
      if (merged.rows.length > 0) {
        enemies.push({
          id: this.lockedBossId,
          name: merged.targetName,
          objectType: this.objectTypes.get(this.lockedBossId) ?? null,
          players: merged.rows,
          cosmetics: this.cosmeticsFor(merged.rows)
        })
      }
    }

    enemies.sort((a, b) => totalDamage(b.players) - totalDamage(a.players))
    return enemies
  }

  /** Frozen cosmetic loadout for each player row, for the detail view's per-player gear/sprite. */
  private cosmeticsFor(rows: PlayerDps[]): Map<number, PlayerCosmetics> {
    const cosmetics = new Map<number, PlayerCosmetics>()
    for (const row of rows) {
      const rec = this.playerCosmetics.get(row.objectId)
      if (rec) cosmetics.set(row.objectId, { ...rec, equipment: rec.equipment?.slice() })
    }
    return cosmetics
  }
}

function totalDamage(rows: PlayerDps[]): number {
  return rows.reduce((sum, row) => sum + row.damage, 0)
}
