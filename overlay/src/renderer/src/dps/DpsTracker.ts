import type { PacketEnvelope } from '../../../shared/ipc'
import { equipmentRarityFromUniqueDataString } from '../sprites/enchantRarity'
import { DpsRateRecorder } from './DpsRateRecorder'
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

/**
 * A sustained direct-attack streak on a target this long overrides the sticky
 * boss lock (see `onLocalHit`) - the local player deliberately committing to
 * something other than the quest objective for 2+ seconds straight, not a
 * stray AoE tick, wins focus back from the boss.
 */
const SUSTAINED_ATTACK_MS = 2000

/**
 * `MapInfoPacket.displayName` is the raw localization key the real client
 * resolves client-side through its own string table - RealmShark only sees
 * the wire value, so a key the client would normally show as a proper name
 * can arrive unresolved (literally e.g. `"{s.rotmg}"`, observed for the
 * open-world Realm, which has no dungeon-style display name of its own).
 * Known keys map to a hand-picked friendly label; anything else shaped like
 * an unresolved key (`{...}`) falls back to a generic label rather than
 * leaking the raw key into the UI.
 */
const KNOWN_UNRESOLVED_DISPLAY_NAMES: Record<string, string> = {
  '{s.rotmg}': 'The Realm'
}

function resolveInstanceDisplayName(displayName: string): string {
  const known = KNOWN_UNRESOLVED_DISPLAY_NAMES[displayName]
  if (known) return known
  if (/^\{.*\}$/.test(displayName)) return 'Unknown Realm'
  return displayName
}

/** packets/data/enums/StatType.java: the stats a player's cosmetic loadout is carried on. */
const SKIN_ID_STAT_TYPE_NUM = 25
const INVENTORY_0_STAT_TYPE_NUM = 8
const CLOTHING_DYE_STAT_TYPE_NUM = 32
const ACCESSORY_DYE_STAT_TYPE_NUM = 33
const UNIQUE_DATA_STRING_STAT_TYPE_NUM = 80 // per-slot encoded enchant data - see sprites/enchantRarity.ts

/** A player's cosmetic loadout, frozen into history at the moment their instance ends. */
export interface PlayerCosmetics {
  objectType: number
  skin?: number
  /** 4 equipped slots (INVENTORY_0..3). Empty slots are `<= 0`. */
  equipment?: number[]
  /** Rarity-border tier (0-4) per equipped slot, decoded from UNIQUE_DATA_STRING - see sprites/enchantRarity.ts. */
  equipmentRarity?: number[]
  /** 4 equipped slots' raw encoded enchant strings (UNIQUE_DATA_STRING), same order as `equipment` - frozen so a retained history entry's gear tooltip still shows enchantments after the live EntityRegistry has moved on to a later instance. */
  enchantSlots?: string[]
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

/**
 * Every envelope type `ingest()`'s switch handles, including the
 * bridge-synthesized ones (`objectNames`/`dps`) that `RELEVANT_TYPES` above
 * omits since those aren't raw game packets. Read by the capture-allowlist
 * tripwire test (`test/allowlist.test.ts`) so a switch case added here
 * without a matching `CAPTURE_ALLOWED_TYPES` entry (`src/shared/capture.ts`)
 * fails a test instead of silently producing a capture the type can never
 * appear in - see PRD §6.2 / docs/overlay-testing.md.
 *
 * NOT derived from the switch below - it's a second, hand-maintained list.
 * The tripwire only catches a missing allowlist entry for a type declared
 * *here*; a switch case added without also updating this list passes the
 * tripwire silently (see the reminder comment on `ingest()` below).
 */
export const CONSUMED_ENVELOPE_TYPES = [
  'CreateSuccessPacket',
  'MapInfoPacket',
  'UpdatePacket',
  'objectNames',
  'dps',
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
 * (QuestObjectIdPacket - the game's own boss/objective marker in a dungeon)
 * AND the local player has actually landed a hit on it, focus locks onto that
 * entity and stays there ("sticky") even while AoEing other enemies. An
 * objective that's active but never damaged by the local player does NOT
 * lock - focus keeps following last-hit until the player actually reaches
 * the boss (see `bossDamagedByLocal`). Once locked, the lock only moves when
 * (a) the locked target dies/despawns, (b) a new quest objective is set - a
 * boss phase change re-points the objective at the next phase's objectId,
 * and the prior phase's per-player damage is carried forward so the total
 * doesn't reset - or (c) the player continuously attacks a different target
 * for `SUSTAINED_ATTACK_MS` straight, which overrides the lock (a deliberate
 * switch away from the boss, not a stray AoE tick - see `onLocalHit`).
 * Outside a quest objective (e.g. open world) it falls back to focusing
 * whichever enemy the local player last hit. Reset on instance change
 * (MapInfoPacket) and meant to also be reset externally when the game closes
 * (electron-overlay-window's "detach" event) - both wipe the same state, just
 * triggered from different places.
 *
 * The local player's objectId is resolved from two sources: CreateSuccessPacket
 * (authoritative but sent only once, at map load - missed if we attach
 * mid-instance) and EnemyHitPacket.mainID (an outgoing packet emitted on every
 * one of our hits, so it re-establishes identity continuously). The latter is
 * what makes DPS work when the sniffer attaches after the player is already
 * in-game; see ingestEnemyHit.
 */
export class DpsTracker {
  /**
   * The time-binned rate recorder (PRD §2): the sparkline's aggregate series
   * and the detail panel's per-(enemy, player) avg/peak metrics. Fed from the
   * `dps` case below; reset with the tracker (instance change / detach).
   */
  readonly recorder = new DpsRateRecorder()

  private entityNames = new Map<number, string>()
  /** Enemy/NPC id -> name, resolved bridge-side from game assets (objectNames envelope). */
  private objectNames = new Map<number, string>()
  /** Bridge-computed DPS, per enemy id -> { name, rows }. Replaces the local DamagePacket estimate. */
  private bridgeEnemies = new Map<number, { name: string; rows: PlayerDps[] }>()
  private targets = new Map<number, Map<number, HitEvent[]>>()
  /**
   * Cumulative per-target-per-attacker DamagePacket totals - unlike the
   * rolling-window buffers in `targets`, these are never trimmed, so the
   * no-bridge fallbacks that need whole-fight totals (`totalDamageRows`, and
   * through it carry-forward/history) can't be corrupted by `snapshot()`'s
   * in-place window trimming. This decoupling is what makes ONE shared
   * tracker safe for both the live panel and history retention (PRD §3);
   * before it, the live panel's periodic snapshots would have silently
   * truncated the history tracker's fallback totals, which is why two
   * separate instances existed.
   */
  private cumulativeDamage = new Map<number, Map<number, number>>()
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
   * Whether the local player has actually landed damage on the *current* boss
   * encounter (persists across a phase's objectId change, since that's still
   * the same encounter - see `ingestQuestObjectId`). Gates the sticky lock
   * itself: an objective can be locked-and-alive with this still false (the
   * player hasn't reached the boss yet), in which case last-hit focus keeps
   * following whatever the player is actually attacking instead of jumping to
   * a boss they haven't touched.
   */
  private bossDamagedByLocal = false
  /** The target of the local player's current unbroken direct-attack streak, and when it started - see SUSTAINED_ATTACK_MS. */
  private localStreakTargetId: number | null = null
  private localStreakStartedAt: number | null = null
  /**
   * Per-attacker damage carried forward from earlier phases of the current
   * (still-open) boss chain, keyed by attacker objectId - accumulated in
   * carryForwardBossDamage whenever the quest objective moves to a new
   * objectId while the previous one is still alive (a genuine phase/form
   * change). snapshot() adds this on top of the current phase's live rows so
   * a boss's total doesn't reset across a phase/form change. Cleared by
   * resolveBossChain whenever the previous objective had already despawned -
   * a new, unrelated encounter starts this back at zero rather than
   * inheriting a dead boss's damage.
   *
   * Besides `damage`, each entry carries the recorder's per-phase metrics
   * fold (`engagedMs`/`peak` - PRD §5): summing engaged spans and taking the
   * max peak across phases is what lets a chain's merged rows keep honest
   * avg/peak numbers instead of the old struct's discarded-to-0 dps.
   */
  private bossCarry = new Map<
    number,
    { name: string; damage: number; engagedMs: number; peak: number }
  >()
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
  /**
   * Every quest-objective objectId ever locked this instance, across every
   * boss encounter (not just the current one) - excludes them all from
   * `buildHistoryEnemies`'s flat per-enemy loop, since each is already
   * accounted for either in `resolvedBossEncounters` (a finished chain) or
   * via the live `bossSnapshot` merge for whichever chain is still open.
   */
  private bossPhaseIds = new Set<number>()
  /**
   * Finished boss encounters from *this* instance, baked in by
   * `resolveBossChain` the moment a new quest objective arrives for a boss
   * that already despawned - i.e. a genuinely new encounter, not a phase of
   * the one that just ended. Kept separate from the still-open chain
   * (`lockedBossId`/`bossCarry`) so a Realm's next quest boss can't have an
   * already-dead prior boss's damage folded into it - see `ingestQuestObjectId`.
   * Per-instance state: cleared in `reset()`, read into the retained history
   * entry by `buildHistoryEnemies` just before that.
   */
  private resolvedBossEncounters: DpsHistoryEnemy[] = []
  /** Retained past-instance summaries, newest first. Session-scoped: survives `reset()`, only cleared by a fresh page load. */
  private history: DpsHistoryEntry[] = []
  private historySeq = 0

  // NOTE: adding/removing a `case` here also means updating
  // `CONSUMED_ENVELOPE_TYPES` above - it's a separate, hand-maintained list
  // (not derived from this switch), so the allowlist tripwire test only
  // catches a missing `CAPTURE_ALLOWED_TYPES` entry for a type this switch
  // AND that list both agree the tracker consumes. See CONSUMED_ENVELOPE_TYPES's
  // own doc comment.
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
          this.currentInstanceName = resolveInstanceDisplayName(mapInfo?.displayName ?? '')
          break
        }
        case 'UpdatePacket':
          this.ingestUpdate(envelope.data as UpdatePacketData)
          break
        case 'objectNames':
          this.ingestObjectNames(envelope.data as Record<string, string>)
          break
        case 'dps': {
          const dps = envelope.data as BridgeDpsData
          this.ingestBridgeDps(dps)
          this.recorder.onSnapshot(dps, envelope.time, this.localPlayerId)
          break
        }
        case 'ServerPlayerShootPacket':
          this.ingestShoot(envelope.data as ServerPlayerShootPacketData)
          break
        case 'EnemyHitPacket':
          this.ingestEnemyHit(envelope.data as EnemyHitPacketData, envelope.time)
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
    stats?: { statTypeNum: number; statValue?: number; stringStatValue?: string }[]
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
      } else if (s.statTypeNum === UNIQUE_DATA_STRING_STAT_TYPE_NUM && s.stringStatValue) {
        rec = rec ?? { objectType }
        rec.equipmentRarity = equipmentRarityFromUniqueDataString(s.stringStatValue)
        rec.enchantSlots = s.stringStatValue.split(',')
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
  private ingestEnemyHit(data: EnemyHitPacketData, time: number): void {
    // Prefer mainID (always the player, even for pet/minion hits); fall back to
    // shooterID if a client build ever sends mainID as 0/absent.
    const playerId = Number.isFinite(data.mainID) && data.mainID > 0 ? data.mainID : data.shooterID
    if (Number.isFinite(playerId) && playerId > 0 && playerId !== this.localPlayerId) {
      dlog('local player id =', playerId, '(from EnemyHitPacket)')
      this.localPlayerId = playerId
    }
    if (Number.isFinite(data.targetId)) {
      this.onLocalHit(data.targetId, time)
      // `kill` is only set on the hit that actually finishes the target off -
      // a direct, immediate despawn signal for whoever gets the killing blow.
      if (data.kill) this.onBossDespawn(data.targetId)
    }
  }

  /**
   * The local player's shot/damage landed on `targetId`. Three cases:
   *
   * 1. `targetId` is the locked boss - marks it as actually engaged
   *    (`bossDamagedByLocal`) and takes focus, always (a hit on the boss
   *    reclaims focus even mid sustained-attack-override, since the player is
   *    no longer sustaining the other target - see case 3).
   * 2. A quest objective is locked, alive, and already damaged by the local
   *    player, and `targetId` is anything else - normally a no-op (AoEing
   *    adds must not steal focus from an engaged boss - issue: sticky DPS
   *    focus), UNLESS the player has been continuously attacking `targetId`
   *    for `SUSTAINED_ATTACK_MS` straight (a deliberate switch away from the
   *    boss, not a stray tick), which overrides the lock.
   * 3. No boss lock in effect (none active, or not yet damaged) - drives the
   *    last-hit fallback focus as before.
   */
  private onLocalHit(targetId: number, nowMs: number): void {
    this.updateLocalStreak(targetId, nowMs)

    if (this.lockedBossId !== null && targetId === this.lockedBossId) {
      if (!this.bossDamagedByLocal) {
        dlog('boss damaged by local player -> locking DPS focus', targetId)
      }
      this.bossDamagedByLocal = true
      this.focusTargetId = targetId
      return
    }

    if (this.lockedBossId !== null && this.bossAlive && this.bossDamagedByLocal) {
      if (this.localStreakDurationMs(nowMs) >= SUSTAINED_ATTACK_MS) {
        dlog('sustained attack ->', targetId, '- overriding sticky boss lock')
        this.focusTargetId = targetId
      }
      return
    }

    this.maybeSwitchFallbackFocus(targetId)
  }

  /** Tracks the local player's unbroken direct-attack streak on one target, for the sustained-attack boss-lock override. */
  private updateLocalStreak(targetId: number, nowMs: number): void {
    if (this.localStreakTargetId !== targetId) {
      this.localStreakTargetId = targetId
      this.localStreakStartedAt = nowMs
    }
  }

  private localStreakDurationMs(nowMs: number): number {
    return this.localStreakStartedAt === null ? 0 : nowMs - this.localStreakStartedAt
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
   * game's own boss/objective marker, e.g. a dungeon's main boss. Arms the
   * sticky lock (see onLocalHit) and, if a boss was already locked, either:
   *
   * - **still alive** (`bossAlive` true) - a genuine phase/form change on the
   *   same encounter, so its accumulated per-player damage is carried
   *   forward (`carryForwardBossDamage`) so the fight's total doesn't reset;
   * - **already dead** (`bossAlive` false) - a wholly new, unrelated
   *   encounter (the next quest boss - the common case in the open-world
   *   Realm, which cycles through many independent quest bosses with no
   *   instance change between them, but equally applies to any instance with
   *   more than one distinct boss). Carrying its damage forward here would
   *   misattribute the boss that was just killed to whichever boss locks
   *   next, so instead the just-finished chain is baked into its own
   *   `resolvedBossEncounters` entry (`resolveBossChain`) and the new chain
   *   starts from zero.
   *
   * Does NOT force `focusTargetId` onto a boss the local player hasn't
   * damaged yet (`bossDamagedByLocal` false) - the panel keeps following
   * whatever the player is actually attacking (last-hit) until they land a
   * hit on the objective, at which point `onLocalHit` takes over. A phase
   * transition on an already-engaged encounter (`bossDamagedByLocal` true,
   * carried over below) does still snap focus straight to the new phase,
   * since that's a continuation of a fight already in progress - but only
   * if the previous lock is still alive; if it already died, this is a
   * genuinely new objective rather than a phase transition, so
   * `bossDamagedByLocal` resets the same as a fresh encounter (see the
   * `lockedBossId === null` branch below).
   */
  private ingestQuestObjectId(data: QuestObjectIdPacketData): void {
    const newId = data.objectId
    if (!Number.isFinite(newId) || newId <= 0 || newId === this.lockedBossId) return
    if (this.lockedBossId !== null) {
      if (this.bossAlive) {
        this.carryForwardBossDamage(this.lockedBossId)
      } else {
        this.resolveBossChain()
        this.bossDamagedByLocal = false
      }
      this.bossPhaseIds.add(this.lockedBossId)
    } else {
      this.bossDamagedByLocal = false
    }
    dlog('quest objective ->', newId, `(${this.nameOf(newId)}) - arming sticky DPS lock`)
    this.lockedBossId = newId
    this.bossAlive = true
    this.bossPhaseIds.add(newId)
    if (this.bossDamagedByLocal) {
      this.focusTargetId = newId
    }
  }

  /**
   * Bakes the just-finished boss chain (`lockedBossId`, plus any earlier
   * phases already folded into `bossCarry`) into its own retained
   * `resolvedBossEncounters` entry, then clears `bossCarry` so the next
   * chain starts from zero instead of inheriting a dead boss's damage - see
   * the encounter-vs-phase distinction in `ingestQuestObjectId`.
   */
  private resolveBossChain(): void {
    if (this.lockedBossId === null) return
    const entry = this.bossChainEntry()
    if (entry) this.resolvedBossEncounters.push(entry)
    this.bossCarry.clear()
  }

  /**
   * Runs `bossSnapshot` for the currently locked boss chain and returns its
   * merged rows as a `DpsHistoryEnemy`, or `null` if there's no locked chain
   * or it has no damage yet. Shared by `resolveBossChain` (baking a finished
   * chain into `resolvedBossEncounters`) and `buildHistoryEnemies` (the
   * still-open chain's live entry) so the two boss-chain code paths can't
   * drift apart.
   */
  private bossChainEntry(): DpsHistoryEnemy | null {
    if (this.lockedBossId === null) return null
    const merged = this.bossSnapshot(Date.now(), WINDOW_MS)
    if (merged.rows.length === 0) return null
    return {
      id: this.lockedBossId,
      name: merged.targetName,
      objectType: this.objectTypes.get(this.lockedBossId) ?? null,
      players: merged.rows,
      cosmetics: this.cosmeticsFor(merged.rows)
    }
  }

  /**
   * `id` died/despawned (a kill on it, or it left view via UpdatePacket.drops -
   * this runs for every dropped id, not just the locked boss). Prunes its
   * enemyMaxHp entry so a dead enemy's stale max HP can never block
   * maybeSwitchFallbackFocus from switching to a smaller live target, and also
   * keeps enemyMaxHp from growing unbounded for the whole instance. When `id`
   * is the locked boss, this only marks it no-longer-alive - it does NOT clear
   * focusTargetId, so the panel keeps showing the final numbers until either a
   * new quest objective re-locks (phase transition) or the next hit elsewhere
   * moves focus via the last-hit fallback (see onLocalHit).
   */
  private onBossDespawn(id: number): void {
    this.enemyMaxHp.delete(id)
    if (this.lockedBossId === id) {
      this.bossAlive = false
    }
  }

  /** Snapshot `oldId`'s current per-player damage (and recorder metrics) into `bossCarry`, summing across phases. */
  private carryForwardBossDamage(oldId: number): void {
    for (const [attackerId, row] of this.totalDamageRows(oldId)) {
      const metrics = this.recorder.metricsFor(oldId, attackerId)
      const existing = this.bossCarry.get(attackerId)
      if (existing) {
        existing.damage += row.damage
        existing.engagedMs += metrics?.engagedMs ?? 0
        existing.peak = Math.max(existing.peak, metrics?.peakDps ?? 0)
        if (row.name) existing.name = row.name
      } else {
        this.bossCarry.set(attackerId, {
          name: row.name,
          damage: row.damage,
          engagedMs: metrics?.engagedMs ?? 0,
          peak: metrics?.peakDps ?? 0
        })
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
    const byAttacker = this.cumulativeDamage.get(targetId)
    if (byAttacker) {
      for (const [attackerId, damage] of byAttacker) {
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

    let cumByAttacker = this.cumulativeDamage.get(data.targetId)
    if (!cumByAttacker) {
      cumByAttacker = new Map()
      this.cumulativeDamage.set(data.targetId, cumByAttacker)
    }
    cumByAttacker.set(attackerId, (cumByAttacker.get(attackerId) ?? 0) + data.damageAmount)

    if (DPS_DEBUG && !Number.isFinite(data.damageAmount)) {
      // damageAmount arriving as undefined/NaN means the field name doesn't
      // match the wire format - a prime suspect for "rows show up but read 0".
      dlog('WARNING damageAmount is not finite:', data.damageAmount, 'raw:', data)
    }

    if (this.localPlayerId !== null && attackerId === this.localPlayerId) {
      this.onLocalHit(data.targetId, time)
    }
  }

  /** Wipe all tracked state - call on instance change (handled internally) or the game closing. */
  reset(): void {
    this.entityNames.clear()
    this.objectNames.clear()
    this.bridgeEnemies.clear()
    this.targets.clear()
    this.cumulativeDamage.clear()
    this.focusTargetId = null
    this.localPlayerId = null
    this.minionOwners.clear()
    this.enemyMaxHp.clear()
    this.lockedBossId = null
    this.bossAlive = false
    this.bossDamagedByLocal = false
    this.localStreakTargetId = null
    this.localStreakStartedAt = null
    this.bossCarry.clear()
    this.objectTypes.clear()
    this.playerCosmetics.clear()
    this.bossPhaseIds.clear()
    this.resolvedBossEncounters = []
    this.recorder.resetInstance()
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

    // Attach combined avg/peak metrics (PRD §5): the carried phases' engaged
    // span + the current phase's recorder fold. A row with no observed span
    // anywhere gets no metrics (renders "—", never a fake 0).
    for (const row of merged.values()) {
      const carry = this.bossCarry.get(row.objectId)
      const live = this.recorder.metricsFor(targetId, row.objectId)
      const engagedMs = (carry?.engagedMs ?? 0) + (live?.engagedMs ?? 0)
      if (engagedMs > 0) {
        row.avgDps = row.damage / (engagedMs / 1000)
        row.peakDps = Math.max(carry?.peak ?? 0, live?.peakDps ?? 0, row.avgDps)
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
    if (
      this.bridgeEnemies.size === 0 &&
      this.lockedBossId === null &&
      this.resolvedBossEncounters.length === 0
    )
      return

    const enemies = this.buildHistoryEnemies()
    if (enemies.length === 0) return

    const maxDamage = Math.max(...enemies.map((e) => totalDamage(e.players)))
    const bossEngaged = this.lockedBossId !== null || this.resolvedBossEncounters.length > 0
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
   * Builds the ranked, boss-phase-merged enemy list for a history snapshot:
   * every boss chain finished earlier this instance (`resolvedBossEncounters`
   * - each already its own merged entry, baked in by `resolveBossChain` the
   * moment it was superseded by an unrelated new encounter), plus the
   * flat non-boss enemies, plus the still-open chain (if any). `bridgeEnemies`
   * holds one entry per raw objectId the bridge has ever seen the local user
   * hit this instance, including every phase id any boss chain has ever used
   * (`bossPhaseIds`) - those are excluded from the flat per-enemy loop below
   * since they're already represented in `resolvedBossEncounters` or the
   * still-open chain's merged entry (reusing `bossSnapshot`'s carry-forward
   * merge, the same one the live panel uses for a phase-changing boss - see
   * docs/dps-engine.md's bossPhaseDamage note for why that bridge-side field
   * is NOT what does this merging).
   */
  private buildHistoryEnemies(): DpsHistoryEnemy[] {
    const enemies: DpsHistoryEnemy[] = [...this.resolvedBossEncounters]
    const mergedIds = new Set(this.bossPhaseIds)
    if (this.lockedBossId !== null) mergedIds.add(this.lockedBossId)

    for (const [id, enemy] of this.bridgeEnemies) {
      if (mergedIds.has(id)) continue
      if (totalDamage(enemy.rows) <= 0) continue
      enemies.push({
        id,
        name: enemy.name,
        objectType: this.objectTypes.get(id) ?? null,
        players: this.withMetrics(id, enemy.rows),
        cosmetics: this.cosmeticsFor(enemy.rows)
      })
    }

    const chainEntry = this.bossChainEntry()
    if (chainEntry) enemies.push(chainEntry)

    enemies.sort((a, b) => totalDamage(b.players) - totalDamage(a.players))
    return enemies
  }

  /**
   * Attach the recorder's avg/peak metrics (PRD §5) to each row, for a
   * history freeze. Rows the recorder never observed a delta for (the fight
   * predated our attach, or the rare bridge-absent fallback) stay metric-less
   * - the detail panel renders "—" for those instead of a fake 0.
   */
  private withMetrics(enemyId: number, rows: PlayerDps[]): PlayerDps[] {
    return rows.map((row) => {
      const m = this.recorder.metricsFor(enemyId, row.objectId)
      return m ? { ...row, avgDps: m.avgDps, peakDps: m.peakDps } : row
    })
  }

  /** Frozen cosmetic loadout for each player row, for the detail view's per-player gear/sprite. */
  private cosmeticsFor(rows: PlayerDps[]): Map<number, PlayerCosmetics> {
    const cosmetics = new Map<number, PlayerCosmetics>()
    for (const row of rows) {
      const rec = this.playerCosmetics.get(row.objectId)
      if (rec)
        cosmetics.set(row.objectId, {
          ...rec,
          equipment: rec.equipment?.slice(),
          equipmentRarity: rec.equipmentRarity?.slice(),
          enchantSlots: rec.enchantSlots?.slice()
        })
    }
    return cosmetics
  }
}

function totalDamage(rows: PlayerDps[]): number {
  return rows.reduce((sum, row) => sum + row.damage, 0)
}
