package bridge.dps;

import assets.IdToAsset;
import bridge.dps.enums.CharacterClass;
import java.io.Serializable;
import java.util.*;
import java.util.stream.Collectors;
import packets.data.ObjectStatusData;
import packets.data.StatData;
import packets.data.WorldPosData;
import packets.data.enums.ConditionBits;
import packets.data.enums.ConditionNewBits;
import packets.data.enums.StatType;

public class Entity implements Serializable {

    private boolean isUser;
    public final Stat stat;
    private final transient DpsEngine tomatoData;
    public final int id;
    public int objectType;
    private long creationTime;
    public WorldPosData pos;
    public final ArrayList<ObjectStatusData> statUpdates;
    private final ArrayList<Damage> damageList;
    private final HashMap<Integer, Damage> damagePlayer;
    public final HashMap<Integer, PlayerRemoved> playerDropped;
    public final HashMap<Long, Damage> playerHits;
    private String name;
    private long firstDamageTaken = -1;
    private long lastDamageTaken = -1;
    private int charId;
    public int[] baseStats;
    private boolean isPlayer;
    public long stasisCounter;
    public boolean dammahCountered;

    // Optional override mob id string for SendLoot (e.g., "20493HM" / "20451HM")

    // When non-null, SendLoot should use this instead of objectType for the "mob" field.

    public String lootMobIdOverride;

    // True if this entity is an ephemeral fabricated attribution (no actual world entity)

    public boolean fabricatedAttribution;

    private static final int ORYX_THE_MAD_GOD = 45363;

    private static final int ORYX_THE_MAD_GOD_GUARD_ANIMATION = -935464302;
    private static final int ORYX_THE_MAD_GOD_GUARD_EXALTED_ANIMATION =
        -918686683;
    private static final int CHANCELLOR_DAMMAH = 9635;
    private static final int FORGOTTEN_KING = 29039;
    private static final int FORGOTTEN_KING_REFLECTOR_ANIMATION = -123818367;
    private long lootDropTime;
    private long lootTierTime;

    public Entity(DpsEngine tomatoData, int id, long time) {
        this.tomatoData = tomatoData;
        this.id = id;
        creationTime = time;
        damageList = new ArrayList<>();
        statUpdates = new ArrayList<>();
        stat = new Stat();
        damagePlayer = new HashMap<>();
        playerDropped = new HashMap<>();
        playerHits = new HashMap<>();
    }

    public void entityUpdate(int type, ObjectStatusData status, long timePC) {
        updateStats(status, timePC);
        this.objectType = type;
        try {
            if (type != -1) {
                name = IdToAsset.objectName(type);
            }
        } catch (Exception e) {}
    }

    public void updateStats(ObjectStatusData status, long timePC) {
        statUpdates.add(status);

        SecurityAbilityUseCheck.checkManaFromStasis(this, status.stats);

        SecurityAbilityUseCheck.checkManaFromDecoyUsed(this, status.stats);

        stat.setStats(status.stats);

        pos = status.pos;

        if (status.stats.length > 0) {
            lootTimers(status);

            if (isUser) {
                // STUB: replaced at integration.
                // Original tomato called fame(timePC), tomatoData.player.charStat(...),
                // and MyInfoGUI.updatePlayer(this) here. These are fame/potion tracking and
                // GUI updates, not part of the DPS calculation surface.
            } else if (isPlayer) {
                baseStats = calculateBaseStats();
            }
        }

        // STUB: replaced at integration. Original tomato called ParsePanelGUI.update(this).
    }

    private void lootTimers(ObjectStatusData status) {
        long time = System.currentTimeMillis();
        for (StatData sd : status.stats) {
            if (sd.statType == StatType.LD_TIMER_STAT) {
                lootDropTime = 0;
                int ld = sd.statValue;
                if (ld > 0) {
                    lootDropTime = ld * 1000L + time;
                }
            } else if (sd.statType == StatType.LT_TIMER_STAT) {
                lootTierTime = 0;
                int lt = sd.statValue;
                if (lt > 0) {
                    lootTierTime = lt * 1000L + time;
                }
            }
        }
    }

    public int maxHp() {
        if (stat.get(StatType.MAX_HP_STAT) == null) return 0;
        return stat.get(StatType.MAX_HP_STAT).statValue;
    }

    public int hp() {
        if (stat.get(StatType.HP_STAT) == null) return 0;
        return stat.get(StatType.HP_STAT).statValue;
    }

    public long getLastDamageTaken() {
        return lastDamageTaken;
    }

    public long getFirstDamageTaken() {
        return firstDamageTaken;
    }

    public String getFightTimerString() {
        long time = lastDamageTaken - firstDamageTaken;
        return systemTimeToString(time);
    }

    /**
     * Inline replacement for tomato's DpsGUI.systemTimeToString(t).
     * Formats a millisecond duration as m:ss (or h:mm:ss when hours are present).
     */
    private static String systemTimeToString(long millis) {
        if (millis < 0) millis = 0;
        long totalSeconds = millis / 1000;
        long hours = totalSeconds / 3600;
        long minutes = (totalSeconds % 3600) / 60;
        long seconds = totalSeconds % 60;
        if (hours > 0) {
            return String.format("%d:%02d:%02d", hours, minutes, seconds);
        }
        return String.format("%d:%02d", minutes, seconds);
    }

    public long getFightTimer() {
        return lastDamageTaken - firstDamageTaken;
    }

    public void entityDropped(long time) {
        //        updates.add(status); // TODO fix time
    }

    /**
     * Player entity stats multiplier such as attack, exalts and other buffs.
     *
     * @return damage multiplier from player stats.
     */
    public float playerStatsMultiplier() {
        int condition = stat.get(StatType.CONDITION_STAT).statValue;
        boolean weak = (condition & ConditionBits.WEAK.value()) != 0;
        boolean damaging = (condition & ConditionBits.DAMAGING.value()) != 0;
        int attack = stat.get(StatType.ATTACK_STAT).statValue;
        float exaltDmgBonus =
            (float) stat.get(StatType.EXALTATION_BONUS_DAMAGE).statValue / 1000;

        if (weak) {
            return 0.5f;
        }
        float number = (attack + 25) * 0.02f;
        if (damaging) {
            number *= 1.25;
        }

        // Apply crucible damage bonus if active
        if (this == tomatoData.player) {
            double crucibleMultiplier =
                CrucibleBonusManager.getPlayerDamageMultiplier();
            number *= crucibleMultiplier;
        }

        return number * exaltDmgBonus;
    }

    public void userProjectileHit(
        Entity attacker,
        Projectile projectile,
        long timePc
    ) {
        if (projectile == null || projectile.getDamage() == 0) return;

        int dmg = 0;
        // Header logging moved to the scaling branch so we only log lethal-strike (scaling) client-side calculations
        // for shots originating from the local user. Original header (commented for reference):
        // System.out.println(
        //     "[Entity] userProjectileHit: projectile.containerType=" +
        //         projectile.getContainerType() +
        //         " summonerId=" +
        //         projectile.getSummonerId() +
        //         " baseDamage=" +
        //         projectile.getDamage() +
        //         " attacker=" +
        //         (attacker != null ? attacker.id : -1)
        // );

        // Check if this is an ability projectile (created by ServerPlayerShootPacket)
        // Ability projectiles have non-zero summonerId and use pre-calculated damage from server
        // Weapon projectiles have summonerId = 0 and need client-side defense calculations
        // Proc projectiles have summonerId = 0 but may have stat scaling that needs to be applied
        boolean isAbilityProjectile = projectile.getSummonerId() != 0;
        boolean isProcProjectile = false;

        // Only perform client-side calculations for projectiles with containerType (weapon ID)
        // when they originate from the local user. The server sends final damage for other players'
        // shots, so we must not re-calculate those on the client.
        int containerType = projectile.getContainerType();
        boolean isLocalAttacker = attacker != null && attacker.isUser();
        // Only treat containerType as client-calculable when the attacker is the local user.
        boolean hasContainerType = isLocalAttacker && containerType != -1;
        // Initialize scaling manager here so it's available to the entire hit/defense flow.
        AbilityScalingManager scalingManager =
            AbilityScalingManager.getInstance();

        if (isAbilityProjectile && !hasContainerType) {
            // Ability projectile without containerType: apply defense calculations unless armor piercing
            int baseDamage = projectile.getDamage();
            if (projectile.isArmorPiercing()) {
                // Armor piercing abilities ignore defense - use damage as-is
                dmg = baseDamage;
                if (attacker != null && attacker.isUser()) {
                    System.out.println(
                        "[Entity] userProjectileHit: using armor-piercing ability damage=" +
                            dmg +
                            " (ignores defense)"
                    );
                }
            } else {
                // Non-armor piercing abilities should consider target defense
                int[] conditions = new int[2];
                conditions[0] =
                    stat.get(StatType.CONDITION_STAT) == null
                        ? 0
                        : stat.get(StatType.CONDITION_STAT).statValue;
                conditions[1] =
                    stat.get(StatType.NEW_CON_STAT) == null
                        ? 0
                        : stat.get(StatType.NEW_CON_STAT).statValue;
                int defence =
                    stat.get(StatType.DEFENSE_STAT) == null
                        ? 0
                        : stat.get(StatType.DEFENSE_STAT).statValue;

                dmg = Projectile.damageWithDefense(
                    baseDamage,
                    false, // armorPiercing is false since we're applying defense
                    defence,
                    conditions,
                    -1, // weaponId not available for ability projectiles without containerType
                    attacker
                );
                if (attacker != null && attacker.isUser()) {
                    System.out.println(
                        "[Entity] userProjectileHit: applied defense to ability damage=" +
                            dmg +
                            " (base=" +
                            baseDamage +
                            ", defense=" +
                            defence +
                            ")"
                    );
                }
            }
        } else {
            // Check if this is a proc projectile with stat scaling
            // Proc projectiles come from ServerPlayerShootPacket with containerType as projectile ID
            if (containerType != -1) {
                boolean hasScaling = scalingManager.hasScaling(containerType);
                // Only emit container/scaling discovery logs if the attacker is the local user AND this ability has scaling.
                // This ensures we only debug lethal-strike / scaling client-side calculations for our own shots.
                if (attacker != null && attacker.isUser() && hasScaling) {
                    System.out.println(
                        "[Entity] userProjectileHit: containerType=" +
                            containerType +
                            " hasScaling=" +
                            hasScaling
                    );
                }
                if (hasScaling) {
                    // This is a proc projectile with scaling - attempt to use a stat snapshot
                    Integer statSnapshot = null;
                    try {
                        // Prefer damage-time / current attacker stat for scaling if available.
                        AbilityScalingManager.AbilityScalingData sd =
                            scalingManager.getScalingData(containerType);
                        if (
                            attacker != null &&
                            sd != null &&
                            sd.scalingStat != null &&
                            attacker.stat.get(sd.scalingStat) != null
                        ) {
                            statSnapshot = Integer.valueOf(
                                attacker.stat.get(sd.scalingStat).statValue
                            );
                        } else if (projectile != null) {
                            int s = projectile.getOriginScalingStat();
                            if (s != Integer.MIN_VALUE) {
                                statSnapshot = Integer.valueOf(s);
                            }
                        }
                    } catch (Exception ignored) {}
                    // Use snapshot-aware calculation (falls back to current player stats when snapshot is null)
                    int statBonus = scalingManager.calculateStatBonus(
                        containerType,
                        statSnapshot,
                        attacker
                    );
                    int baseDamage = projectile.getDamage();
                    dmg = baseDamage + statBonus;
                    // Only log the detailed proc scaling message for the local user
                    if (attacker != null && attacker.isUser()) {
                        System.out.println(
                            "[Entity] userProjectileHit: proc scaling applied containerType=" +
                                containerType +
                                " baseDamage=" +
                                baseDamage +
                                " statBonus=" +
                                statBonus +
                                " total=" +
                                dmg +
                                (statSnapshot != null
                                    ? " (used snapshot)"
                                    : " (used current)")
                        );
                    }
                    isProcProjectile = true;
                }
            }

            // Apply defense calculations to all projectiles with containerType
            // This ensures proper scaling is applied
            if (containerType != -1 || !isProcProjectile) {
                // Calculate damage client-side with defense for all projectiles with containerType
                int[] conditions = new int[2];

                conditions[0] =
                    stat.get(StatType.CONDITION_STAT) == null
                        ? 0
                        : stat.get(StatType.CONDITION_STAT).statValue;
                conditions[1] =
                    stat.get(StatType.NEW_CON_STAT) == null
                        ? 0
                        : stat.get(StatType.NEW_CON_STAT).statValue;
                int defence =
                    stat.get(StatType.DEFENSE_STAT) == null
                        ? 0
                        : stat.get(StatType.DEFENSE_STAT).statValue;

                // For proc projectiles with scaling, use the stat-scaled damage as base
                int baseDamage = isProcProjectile
                    ? dmg
                    : projectile.getDamage();

                // Apply the standard defense calculation
                dmg = Projectile.damageWithDefense(
                    baseDamage,
                    projectile.isArmorPiercing(),
                    defence,
                    conditions
                );
            }
        }

        if (dmg > 0) {
            Damage damage = new Damage(attacker, projectile, timePc, dmg);
            bossPhaseDamage(damage);
            addPlayerDmg(damage);
            // Only record the detailed recorded-damage log for local-user lethal-strike (scaling) hits.
            if (
                attacker != null &&
                attacker.isUser() &&
                AbilityScalingManager.getInstance().hasScaling(
                    projectile.getContainerType()
                )
            ) {
                System.out.println(
                    "[Entity] userProjectileHit: recorded damage owner=" +
                        attacker.id +
                        " dmg=" +
                        dmg +
                        " target=" +
                        this.id
                );
            }
        }
    }

    
public void genericDamageHit(
        Entity attacker,
        Projectile projectile,
        long time
    ) {
        if (projectile == null || projectile.getDamage() == 0) return;
        Damage damage = new Damage(attacker, projectile, time);
        bossPhaseDamage(damage);
        addPlayerDmg(damage);
    }

    // STUB: replaced at integration.
    // No-op stand-in for tomato's SlotType 18 ability tracking (used for a DamagePacket
    // invulnerability bypass). Signature preserved so call sites compile; the behavior is
    // not part of the DPS calculation surface handled here.
    public static void trackSlotType18AbilityUse(Entity player, long time) {
        // no-op
    }

    private void addPlayerDmg(Damage damage) {
        damageList.add(damage);

        if (damage.owner != null) {
            int id = damage.owner.id;
            Damage dmg = damagePlayer.computeIfAbsent(id, a ->
                new Damage(damage.owner)
            );
            dmg.add(damage);
        }
    }

    public void userDamageTaken(Entity e, long timePc, Projectile p) {
        int dmg = p.getDamage();
        dmg = calculatePlayerDmg(dmg, p.isArmorPiercing());
        Damage d = new Damage(e, timePc, dmg);
        damageList.add(d);
    }

    private int calculatePlayerDmg(int dmg, boolean ap) {
        int def = stat.get(StatType.DEFENSE_STAT).statValue;
        int condition = stat.get(StatType.CONDITION_STAT).statValue;
        boolean invulnerable =
            (condition & ConditionBits.INVULNERABLE.value()) != 0;

        if (invulnerable) {
            return 0;
        }

        boolean armorBroken =
            (condition & ConditionBits.ARMORBROKEN.value()) != 0;
        boolean armored = (condition & ConditionBits.ARMORED.value()) != 0;
        boolean exposed = (condition & ConditionNewBits.EXPOSED.value()) != 0;
        boolean petrified =
            (condition & ConditionNewBits.PETRIFIED.value()) != 0;
        boolean cursed = (condition & ConditionNewBits.CURSE.value()) != 0;

        if (ap || armorBroken) {
            def = 0;
        } else if (armored) {
            def = (int) (def * 1.5);
        }
        if (exposed) {
            def -= 20;
        }

        float damage = Math.max(dmg * 0.1f, dmg - def);

        if (petrified) {
            damage = (int) (damage * 0.9f);
        }
        if (cursed) {
            damage = (int) (damage * 1.25f);
        }

        return (int) damage;
    }

    private void bossPhaseDamage(Damage damage) {
        damage.oryx3GuardDmg =
            objectType == ORYX_THE_MAD_GOD &&
            stat.get(StatType.ANIMATION_STAT) != null &&
            (stat.get(StatType.ANIMATION_STAT).statValue ==
                    ORYX_THE_MAD_GOD_GUARD_ANIMATION ||
                stat.get(StatType.ANIMATION_STAT).statValue ==
                ORYX_THE_MAD_GOD_GUARD_EXALTED_ANIMATION);
        damage.walledGardenReflectors =
            objectType == FORGOTTEN_KING &&
            stat.get(StatType.ANIMATION_STAT) != null &&
            stat.get(StatType.ANIMATION_STAT).statValue ==
            FORGOTTEN_KING_REFLECTOR_ANIMATION &&
            tomatoData.hasGuardedPhaseEntity();
        damage.chancellorDammahDmg =
            objectType == CHANCELLOR_DAMMAH && !dammahCountered;
    }

    public String name() {
        if (
            CharacterClass.isPlayerCharacter(objectType) &&
            stat.get(StatType.NAME_STAT) != null
        ) {
            return stat.get(StatType.NAME_STAT).stringStatValue.split(",")[0];
        }
        return name;
    }

    public String getStatName() {
        if (stat.get(StatType.NAME_STAT) == null) return null;
        return stat.get(StatType.NAME_STAT).stringStatValue;
    }

    public String getStatGuild() {
        if (stat.get(StatType.GUILD_NAME_STAT) == null) return null;
        return stat.get(StatType.GUILD_NAME_STAT).stringStatValue;
    }

    public boolean isSeasonal() {
        if (stat.get(StatType.SEASONAL) == null) return false;
        return stat.get(StatType.SEASONAL).statValue == 1;
    }

    public boolean isCrucible() {
        if (stat.get(StatType.CRUCIBLE_STAT) == null) return false;
        return !stat.get(StatType.CRUCIBLE_STAT).stringStatValue.isEmpty();
    }

    public ArrayList<Damage> getDamageList() {
        return damageList;
    }

    public List<Damage> getPlayerDamageList() {
        return Arrays.stream(damagePlayer.values().toArray(new Damage[0]))
            .sorted(Comparator.comparingInt(Damage::getDamage).reversed())
            .collect(Collectors.toList());
    }

    public int playersRemainAtKill() {
        int count = 0;
        for (int id : damagePlayer.keySet()) {
            if (!playerDropped.containsKey(id)) {
                count++;
            }
        }
        return count;
    }

    public boolean isUser() {
        return isUser;
    }

    public void isPlayer() {
        isPlayer = true;
        baseStats = calculateBaseStats();
    }

    public void setUser(int charId) {
        isUser = true;
        this.charId = charId;
        baseStats = calculateBaseStats();
    }

    private int[] calculateBaseStats() {
        int[] base = new int[8];

        base[0] =
            stat.get(StatType.MAX_HP_STAT).statValue -
            stat.get(StatType.MAX_HP_BOOST_STAT).statValue;
        base[1] =
            stat.get(StatType.MAX_MP_STAT).statValue -
            stat.get(StatType.MAX_MP_BOOST_STAT).statValue;
        base[2] =
            stat.get(StatType.ATTACK_STAT).statValue -
            stat.get(StatType.ATTACK_BOOST_STAT).statValue;
        base[3] =
            stat.get(StatType.DEFENSE_STAT).statValue -
            stat.get(StatType.DEFENSE_BOOST_STAT).statValue;
        base[4] =
            stat.get(StatType.SPEED_STAT).statValue -
            stat.get(StatType.SPEED_BOOST_STAT).statValue;
        base[5] =
            stat.get(StatType.DEXTERITY_STAT).statValue -
            stat.get(StatType.DEXTERITY_BOOST_STAT).statValue;
        base[6] =
            stat.get(StatType.VITALITY_STAT).statValue -
            stat.get(StatType.VITALITY_BOOST_STAT).statValue;
        base[7] =
            stat.get(StatType.WISDOM_STAT).statValue -
            stat.get(StatType.WISDOM_BOOST_STAT).statValue;

        return base;
    }

    // STUB: replaced at integration.
    // Original tomato had private void fame(long) and public void charStat(int, int[]) here,
    // plus a getClassNameFromObjectType(int) helper. They drove fame tracking and potion/stat
    // maxing GUIs via RealmCharacter/charMap/FameTracker/FameTableBridge/CharacterStatMaxingGUI,
    // none of which are part of the DPS calculation surface. Removed to keep this package
    // self-contained.

    public void addPlayerDrop(int dropId, long time) {
        int hp = hp();
        int max = maxHp();
        String name = name();
        PlayerRemoved pr = new PlayerRemoved(dropId, hp, max, name, time);
        playerDropped.put(dropId, pr);
    }

    public double distSqrd(WorldPosData p) {
        double x = pos.x - p.x;
        double y = pos.y - p.y;
        return x * x + y * y;
    }

    public long lootDropTime(long time) {
        if (lootDropTime == 0) return lootDropTime;
        return lootDropTime - time;
    }

    public long getFightDuration() {
        return lastDamageTaken - firstDamageTaken;
    }

    public int[] damageTaken(Entity entity) {
        int[] dmg = new int[2];
        long first = 0;
        long last = Long.MAX_VALUE;
        if (entity != null) {
            first = entity.firstDamageTaken;
            last = entity.lastDamageTaken;
        }
        for (Damage d : damageList) {
            long time = d.time;
            if (first < time && time < last) {
                dmg[0] += d.damage;
                dmg[1]++;
            }
        }
        return dmg;
    }

    public void updateDamageTaken(long timePc) {
        if (firstDamageTaken == -1) {
            firstDamageTaken = timePc;
        }
        lastDamageTaken = timePc;
    }

    public boolean isBossMob() {
        String label = IdToAsset.getIdLabel(objectType);
        if (label != null) {
            String[] split = label.split(",");
            for (String s : split) {
                if (s.equals("BOSS") || s.equals("MINIBOSS")) return true;
            }
        }
        return false;
    }
}
