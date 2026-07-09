package bridge.dps;

import bridge.dps.enums.CharacterClass;
import java.util.HashMap;
import packets.data.ObjectData;
import packets.data.enums.StatType;
import packets.incoming.DamagePacket;
import packets.incoming.MapInfoPacket;
import packets.incoming.NewTickPacket;
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;
import packets.outgoing.EnemyHitPacket;
import packets.outgoing.PlayerShootPacket;
import util.RNG;

/**
 * DPS calculation engine, ported from the DPS-relevant subset of tomato's
 * {@code tomato.backend.data.TomatoData}.
 *
 * <p>This is a faithful port: the damage math, projectile bookkeeping, RNG seeding, and
 * minion/pet attribution are preserved byte-for-byte. Everything non-DPS from TomatoData
 * (loot attribution, pets, sounds, chat/entity/item pings, quests, vault, exalts, moonlight
 * flames, dungeon stats, char-list HTTP requests, prop lists) has been omitted, and GUI /
 * security couplings have been stubbed. Points where tomato did more are marked
 * {@code // STUB: replaced at integration}.</p>
 *
 * <h2>Reading damage out</h2>
 * <p>{@link #getEntityHitList()} returns every enemy {@link Entity} the local user's shots
 * (or attributed minions) have hit this instance. For each such enemy:</p>
 * <ul>
 *   <li>{@code entity.getPlayerDamageList()} → per-player aggregated {@link Damage}
 *       (one entry per attacking player, sorted by total damage descending). Each
 *       {@code Damage.owner} is the attacking player {@link Entity}, {@code Damage.damage}
 *       the summed damage that player dealt to this enemy.</li>
 *   <li>{@code entity.getDamageList()} → the raw per-hit {@link Damage} list.</li>
 *   <li>{@code entity.name()} identifies the enemy; {@code entity.getFightTimer()} /
 *       {@code getFightDuration()} give the fight window.</li>
 * </ul>
 */
public class DpsEngine {

    public MapInfoPacket map;
    protected int worldPlayerId;
    protected int charId;
    public long time;
    public long timePc;
    private long timePcFirst;
    public Entity player;
    public final HashMap<Integer, Entity> entityList = new HashMap<>();
    protected final HashMap<Integer, Entity> playerList = new HashMap<>();
    public final HashMap<Integer, Entity> playerListUpdated = new HashMap<>();
    protected final Projectile[] projectiles = new Projectile[512];
    // Map keyed by (ownerId << 32) | (bulletId & 0xffffffffL) for reliable lookup of player/server-created projectiles
    protected final HashMap<Long, Projectile> playerProjectiles =
        new HashMap<>();
    protected RNG rng;
    private HashMap<Integer, Entity> entityHitList = new HashMap<>();
    protected final HashMap<Integer, Entity> dropList = new HashMap<>();
    private final java.util.ArrayList<Entity> killedEntitys =
        new java.util.ArrayList<>();

    // Track minion/summon to owner mapping for damage attribution
    // Key: minion/summon objectId, Value: owner/player objectId
    private final HashMap<Integer, Integer> minionOwnerMap = new HashMap<>();

    /**
     * Sets the current realm.
     *
     * @param map New realm to be set.
     */
    public void setNewRealm(MapInfoPacket map) {
        clear();
        // STUB: replaced at integration. Original tomato called ParsePanelGUI.clear()
        // and petYardCheck(map.displayName) here (GUI / pet-yard handling).
        this.map = map;
        rng = new RNG(map.seed);
    }

    /**
     * Sets the current realm users character id.
     *
     * @param objectId ID of the object in the world.
     * @param charId   Current character id loaded.
     * @param str
     */
    public void setUserId(int objectId, int charId, String str) {
        this.worldPlayerId = objectId;
        this.charId = charId;
        // STUB: replaced at integration. Original tomato called updateDungeonStats(charId, str)
        // here (dungeon-completion stat tracking, non-DPS).
    }

    /**
     * Sets the time of the server.
     *
     * @param serverRealTimeMS Server time in milliseconds.
     */
    public void setTime(long serverRealTimeMS) {
        time = serverRealTimeMS;
        timePc = System.currentTimeMillis();
        if (timePcFirst == -1) timePcFirst = timePc;
    }

    /**
     * Main update packet.
     *
     * @param p Update packet
     */
    public void update(UpdatePacket p) {
        // STUB: replaced at integration. Original tomato copied p.tiles into a 2048x2048
        // mapTiles grid here, used only for ground-tile damage taken by the player (non-DPS).
        for (int i = 0; i < p.newObjects.length; i++) {
            ObjectData object = p.newObjects[i];
            entityUpdate(object);
        }
        for (int i = 0; i < p.drops.length; i++) {
            int dropId = p.drops[i];
            Entity e = entityList.get(dropId);
            dropList.put(dropId, e);

            // Clean up minion ownership mapping when minion despawns
            minionOwnerMap.remove(dropId);
            if (e != null) {
                if (isPlayerEntity(e.objectType)) {
                    for (java.util.Map.Entry<
                        Integer,
                        Entity
                    > dropCheck : entityHitList.entrySet()) {
                        int k = dropCheck.getKey();
                        if (!dropList.containsKey(k)) {
                            dropCheck.getValue().addPlayerDrop(dropId, timePc);
                        }
                    }
                }
            }

            if (entityHitList.containsKey(dropId)) {
                killedEntitys.add(e);
            }

            playerListUpdated.remove(dropId);
            // STUB: replaced at integration. Original tomato called ParsePanelGUI.removePlayer(dropId).
        }
    }

    /**
     * Adds an entity to the entity lists as well as updates objects.
     *
     * @param object Entity object to be added or updated
     */
    private void entityUpdate(ObjectData object) {
        int id = object.status.objectId;
        Entity entity = entityList.computeIfAbsent(id, idd ->
            new Entity(this, idd, timePc)
        );
        int idType = object.objectType;
        entity.entityUpdate(idType, object.status, timePc);

        // STUB: replaced at integration. Original tomato handled, for new objects,
        // moonlight-flame counting, SecurityAbilityUseCheck.decoy, and custom sound alerts,
        // plus pet-yard / crystal / loot-bag tracking. None are part of the DPS surface.
        if (isPlayerEntity(idType)) {
            playerList.put(id, entity);
            playerListUpdated.put(id, entity);
            if (id == worldPlayerId) {
                player = entity;
                entity.setUser(charId);
                // STUB: replaced at integration. Original tomato called MyInfoGUI.updatePlayer(player).
            } else {
                entity.isPlayer();
            }
            // STUB: replaced at integration. Original tomato called ParsePanelGUI.addPlayer(id, entity).
        }
    }

    /**
     * Checks if any guarded phase entities exist for Forgotten King fight.
     *
     * @return True if any of the guarded phase entities (33656, 33557, 33572) exist
     */
    public boolean hasGuardedPhaseEntity() {
        for (Entity entity : entityList.values()) {
            int objectType = entity.objectType;
            if (
                objectType == 33656 ||
                objectType == 33557 ||
                objectType == 33572
            ) {
                return true;
            }
        }
        return false;
    }

    /**
     * Checks if objectType is a player entity.
     *
     * @param objectType ID of the object
     * @return True if ID matches a player entity.
     */
    private boolean isPlayerEntity(int objectType) {
        return CharacterClass.isPlayerCharacter(objectType);
    }

    /**
     * Entity updates and server time from new tick packet.
     *
     * @param p New tick packet.
     */
    public void updateNewTick(NewTickPacket p) {
        setTime(p.serverRealTimeMS);
        for (int i = 0; i < p.status.length; i++) {
            int id = p.status[i].objectId;
            Entity entity = entityList.computeIfAbsent(id, idd ->
                new Entity(this, idd, timePc)
            );
            entity.updateStats(p.status[i], timePc);
        }
        // STUB: replaced at integration. Original tomato called
        // SecurityAbilityUseCheck.decreaseDecoyCounter() and lootTick() here.
    }

    /**
     * Creates a new projectile from the outgoing packet.
     *
     * @param p Projectile info.
     */
    public void playerShoot(PlayerShootPacket p) {
        Projectile proj = new Projectile(
            rng,
            player,
            p.weaponId,
            p.projectileId
        );
        // Store in the fixed-size array for quick access (legacy)
        if (p.bulletId >= 0 && p.bulletId < projectiles.length) {
            projectiles[p.bulletId] = proj;
        }
        // Also store in a keyed map using the shooter (owner) + bulletId so lookups are unambiguous
        if (player != null) {
            long key = (((long) player.id) << 32) | (p.bulletId & 0xffffffffL);
            playerProjectiles.put(key, proj);

            // Track SlotType 18 ability usage for DamagePacket invulnerability bypass
            Entity.trackSlotType18AbilityUse(player, timePc);
        }
    }

    /**
     * Projectile info of other players.
     *
     * @param p Projectile info
     */
    public void serverPlayerShoot(ServerPlayerShootPacket p) {
        // Track SlotType 18 ability usage for DamagePacket invulnerability bypass
        Entity ownerEntity = playerList.get(p.ownerId);
        if (ownerEntity != null) {
            Entity.trackSlotType18AbilityUse(ownerEntity, timePc);
        }

        /*
         * MINION/SUMMON DAMAGE ATTRIBUTION:
         * When pets, minions, traps, or other summons shoot projectiles, the game sends
         * ServerPlayerShootPacket with:
         *   - ownerId = the minion/summon entity's objectId (e.g., objectType=5805 for traps)
         *   - summonerId = the player owner's objectId (e.g., objectType=801 for players)
         *
         * We track this relationship in minionOwnerMap so that when DamagePacket arrives
         * with the minion's objectId as the attacker, we can attribute the damage to the
         * player owner instead of showing "NO_NAME" in DPS logs.
         *
         * Example flow:
         * 1. ServerPlayerShootPacket: ownerId=218776 (minion), summonerId=202734 (player "BinaryGhost")
         *    → We store: minionOwnerMap[218776] = 202734
         * 2. DamagePacket: objectId=218776 (minion did damage)
         *    → We lookup: minionOwnerMap.get(218776) → 202734
         *    → Damage attributed to "BinaryGhost" instead of "NO_NAME"
         */
        if (p.summonerId != 0 && p.ownerId != 0) {
            minionOwnerMap.put(p.ownerId, p.summonerId);
        }

        if (p.bulletCount > 1) {
            Projectile projectile = new Projectile(
                p.damage,
                p.containerType,
                p.bulletType,
                p.summonerId
            );
            for (int j = p.bulletId; j < p.bulletId + p.bulletCount; j++) {
                int arrIndex = (j % 256) + 256;
                if (arrIndex >= 0 && arrIndex < projectiles.length) {
                    projectiles[arrIndex] = projectile;
                }
                // Map by ownerId + bullet index so we can reliably resolve this projectile later
                long key =
                    (((long) p.ownerId) << 32) | (arrIndex & 0xffffffffL);
                playerProjectiles.put(key, projectile);
            }
        } else if (p.bulletId > 255 && p.bulletId < 512) {
            Projectile projectile = new Projectile(
                p.damage,
                p.containerType,
                p.bulletType,
                p.summonerId
            );
            // Snapshot origin info for this server-created projectile (ability item + scaling stat)
            try {
                ownerEntity = playerList.get(p.ownerId);
                if (
                    ownerEntity != null &&
                    ownerEntity.stat != null &&
                    ownerEntity.stat.get(StatType.INVENTORY_1_STAT) != null
                ) {
                    try {
                        int abilityId = ownerEntity.stat.get(
                            StatType.INVENTORY_1_STAT
                        ).statValue;
                        projectile.setOriginAbilityItem(abilityId);
                    } catch (Exception ignored) {}
                    try {
                        AbilityScalingManager asm =
                            AbilityScalingManager.getInstance();
                        AbilityScalingManager.AbilityScalingData sd =
                            asm.getScalingData(p.containerType);
                        if (sd != null && sd.scalingStat != null) {
                            if (ownerEntity.stat.get(sd.scalingStat) != null) {
                                projectile.setOriginScalingStat(
                                    ownerEntity.stat.get(
                                        sd.scalingStat
                                    ).statValue
                                );
                            }
                        }
                    } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
            projectiles[p.bulletId] = projectile;
            long key = (((long) p.ownerId) << 32) | (p.bulletId & 0xffffffffL);
            playerProjectiles.put(key, projectile);
        } else {
            // Best-effort: still add to map for wrapped variants
            Projectile projectile = new Projectile(
                p.damage,
                p.containerType,
                p.bulletType,
                p.summonerId
            );
            int arrIndex = (p.bulletId % 256) + 256;
            if (arrIndex >= 0 && arrIndex < projectiles.length) {
                projectiles[arrIndex] = projectile;
            }
            // Snapshot origin info for wrapped/server variant projectile
            try {
                ownerEntity = playerList.get(p.ownerId);
                if (
                    ownerEntity != null &&
                    ownerEntity.stat != null &&
                    ownerEntity.stat.get(StatType.INVENTORY_1_STAT) != null
                ) {
                    try {
                        int abilityId = ownerEntity.stat.get(
                            StatType.INVENTORY_1_STAT
                        ).statValue;
                        projectile.setOriginAbilityItem(abilityId);
                    } catch (Exception ignored) {}
                    try {
                        AbilityScalingManager asm =
                            AbilityScalingManager.getInstance();
                        AbilityScalingManager.AbilityScalingData sd =
                            asm.getScalingData(p.containerType);
                        if (sd != null && sd.scalingStat != null) {
                            if (ownerEntity.stat.get(sd.scalingStat) != null) {
                                projectile.setOriginScalingStat(
                                    ownerEntity.stat.get(
                                        sd.scalingStat
                                    ).statValue
                                );
                            }
                        }
                    } catch (Exception ignored) {}
                }
            } catch (Exception ignored) {}
            long key = (((long) p.ownerId) << 32) | (arrIndex & 0xffffffffL);
            playerProjectiles.put(key, projectile);
        }
    }

    /**
     * Handles entity's being hit by users projectiles.
     *
     * @param p Info about what entity was hit by what projectile.
     */
    public void enemtyHit(EnemyHitPacket p) {
        // Attempt a reliable map lookup first using shooter (owner) + bulletId.
        Projectile projectile = null;
        int shooterIdCandidate = p.shooterID;
        long key =
            (((long) shooterIdCandidate) << 32) | (p.bulletId & 0xffffffffL);
        projectile = playerProjectiles.get(key);

        // If not found, try a few fallbacks: wrapped server index and direct array index
        if (projectile == null) {
            int wrappedIndex = (p.bulletId % 256) + 256;
            if (wrappedIndex >= 0 && wrappedIndex < projectiles.length) {
                projectile = projectiles[wrappedIndex];
            }
        }

        if (projectile == null) {
            if (p.bulletId >= 0 && p.bulletId < projectiles.length) {
                projectile = projectiles[p.bulletId];
            }
        }

        int id = p.targetId;
        Entity target = entityList.computeIfAbsent(id, idd ->
            new Entity(this, idd, timePc)
        );

        int shooterId = p.shooterID;
        if (projectile != null && projectile.getSummonerId() != 0) {
            shooterId = projectile.getSummonerId();
        }
        Entity attacker = playerList.get(shooterId);
        target.userProjectileHit(attacker, projectile, timePc);
        if (!entityHitList.containsKey(id)) {
            entityHitList.put(id, target);
            // STUB: replaced at integration. Original tomato called
            // dungeonStatData.updateEntityDamage(map.name, target) for local-user hits.
        }
        target.updateDamageTaken(timePc);
    }

    /**
     * Info related to damage taken on entity's.
     *
     * @param p Info on entity taking damage, amount and by what player.
     */
    public void damage(DamagePacket p) {
        int id = p.targetId;
        Entity target = entityList.computeIfAbsent(id, idd ->
            new Entity(this, idd, timePc)
        );

        /*
         * ATTACKER RESOLUTION & MINION DAMAGE ATTRIBUTION:
         * DamagePacket.objectId contains the entity ID of whoever/whatever dealt the damage.
         * This could be:
         *   1. A player (found in playerList)
         *   2. A pet/minion/summon/trap (found in entityList, not playerList)
         *
         * For minions/summons, we check minionOwnerMap (populated by ServerPlayerShootPacket)
         * to find the player owner and attribute damage to them instead of showing "NO_NAME".
         *
         * This ensures all player-owned entities' damage appears under the player's name in DPS logs.
         */
        Entity attacker = playerList.get(p.objectId);

        // Fallback to entityList if not found in playerList (handles pets, minions, summons, etc.)
        if (attacker == null) {
            attacker = entityList.get(p.objectId);

            if (attacker != null) {
                // Check if this entity is a minion/summon with a known owner
                Integer ownerId = minionOwnerMap.get(p.objectId);
                if (ownerId != null) {
                    Entity owner = playerList.get(ownerId);
                    if (owner != null) {
                        // Replace attacker with the owner for damage attribution
                        attacker = owner;
                    } else {
                        // Owner not found in playerList, ignore this damage
                        attacker = null;
                    }
                } else {
                    // Minion/summon has no owner mapping, ignore this damage
                    attacker = null;
                }
            }
        }

        if (p.damageAmount > 0) {
            Projectile projectile = new Projectile(p.damageAmount);
            target.genericDamageHit(attacker, projectile, timePc);
            if (!entityHitList.containsKey(id)) {
                entityHitList.put(id, target);
                // STUB: replaced at integration. Original tomato called
                // dungeonStatData.updateEntityDamage(map.name, target) for local-user hits.
            }
        }

        target.updateDamageTaken(timePc);
    }

    /**
     * Clears all data as instance is changing.
     */
    public void clear() {
        worldPlayerId = -1;
        charId = -1;
        time = -1;
        // STUB: replaced at integration. Original tomato archived a DpsData snapshot into
        // dpsData, refreshed DpsGUI, and updated dungeonStatData here before resetting.
        timePc = -1;
        timePcFirst = -1;
        rng = null;
        player = null;
        entityList.clear();
        playerList.clear();
        playerListUpdated.clear();
        dropList.clear();
        minionOwnerMap.clear();
        entityHitList = new HashMap<>();
        for (Projectile p : projectiles) {
            if (p != null) p.clear();
        }
        killedEntitys.clear();
    }

    public Entity[] getEntityHitList() {
        return entityHitList.values().toArray(new Entity[0]);
    }

    public long dungeonTime() {
        return timePc - timePcFirst;
    }
}
