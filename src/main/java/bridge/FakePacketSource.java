package bridge;

import packets.data.GroundTileData;
import packets.data.ObjectData;
import packets.data.ObjectStatusData;
import packets.data.StatData;
import packets.data.WorldPosData;
import packets.data.enums.StatType;
import packets.incoming.CreateSuccessPacket;
import packets.incoming.DamagePacket;
import packets.incoming.MapInfoPacket;
import packets.incoming.NewTickPacket;
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;
import packets.outgoing.EnemyHitPacket;
import packets.outgoing.PlayerShootPacket;
import packets.packetcapture.register.Register;

import java.util.Random;

/**
 * Debug packet source. Emits synthetic packets through the same {@link Register}
 * pipeline the real sniffer uses, so the bridge and any UI can be developed
 * without the game or Npcap running. Enabled with the {@code --fake} flag.
 * <p>
 * Emits a stable fake player roster (via an {@link UpdatePacket} carrying
 * NAME_STAT, same shape a real client sees on entering a map), a
 * {@link CreateSuccessPacket} assigning the local player identity to the
 * first roster member, a {@link ServerPlayerShootPacket} establishing a fake
 * pet owned by the local player (to exercise minion-damage attribution),
 * an outgoing {@link EnemyHitPacket} every tick (the local player hitting an
 * enemy - the reliable, continuously-emitted local-player and focus-target
 * signal that does not depend on catching the one-shot CreateSuccessPacket),
 * and loops {@link DamagePacket}s against two distinct fake enemies attributed
 * to random roster members or the fake pet - enough surface to exercise
 * per-enemy DPS tracking, local-player focus-target attribution, minion
 * attribution, and periodic instance resets (a {@link MapInfoPacket} every
 * ~40 ticks).
 */
public class FakePacketSource {

    private static final int[] ROSTER_IDS = {1, 2, 3, 4};
    private static final String[] ROSTER_NAMES = {"Alice", "Bob", "Carol", "Dave"};
    private static final int LOCAL_PLAYER_ID = ROSTER_IDS[0]; // "you" are Alice

    private static final int[] ENEMY_IDS = {100_000, 100_001};
    // objectTypes for the two fake enemies - resolved to names via IdToAsset
    // (see the synthetic assets/ObjectID.list used for local testing). Unlike
    // players, enemies carry no NAME_STAT, so their name comes from the type.
    private static final int[] ENEMY_TYPES = {1900, 1901};

    // A fake pet owned by the local player, to exercise minion-damage attribution.
    private static final int PET_ID = 50;

    // Weapon the local player "fires" (must exist in the loaded assets/ObjectID.list
    // with projectile damage) so the engine can compute self-damage from the
    // outgoing PlayerShoot -> EnemyHit projectile path.
    private static final int WEAPON_ID = 4000;

    // The local player's equipped skin (SKIN_ID, an objectType) and 4 equipped
    // slots (INVENTORY_0..3: weapon/ability/armor/ring, each an item objectType),
    // so the overlay's Character panel is exercisable in fake mode. Values are
    // arbitrary plausible objectTypes - the overlay resolves them through the
    // shared Sprite path (real atlas sprite if assets loaded, else placeholder).
    private static final int LOCAL_SKIN_ID = 2500;
    private static final int[] LOCAL_EQUIPMENT = {WEAPON_ID, 4100, 4200, 4300};

    // Set FAKE_NO_CREATE_SUCCESS to simulate a mid-session attach: the engine
    // never sees CreateSuccessPacket and must fall back to EnemyHitPacket.mainID
    // to identify the local player (exercises DpsEngine.resolveLocalPlayer).
    private static final boolean SKIP_CREATE_SUCCESS =
        System.getenv("FAKE_NO_CREATE_SUCCESS") != null;

    private final Random rng = new Random();
    private int mapNumber = 1;

    /** Start emitting fake packets on a background daemon thread. */
    public void start() {
        Thread t = new Thread(this::loop, "fake-packet-source");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        int tick = 0;
        // Enter a map first, like a real client: MapInfoPacket seeds the engine's
        // RNG, which the weapon-damage roll needs (no seed -> 0-damage shots).
        Register.INSTANCE.emitPacketLogs(mapInfo());
        if (!SKIP_CREATE_SUCCESS) Register.INSTANCE.emitPacketLogs(createSuccess());
        while (!Thread.currentThread().isInterrupted()) {
            // Resend the roster and pet-ownership mapping periodically (real
            // UpdatePackets/ServerPlayerShootPackets only arrive on specific
            // events) so a client that connects even a moment late still picks
            // them up within a few seconds, not never.
            if (tick % 15 == 0) {
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
                Register.INSTANCE.emitPacketLogs(enemyUpdate());
                Register.INSTANCE.emitPacketLogs(petOwnership());
            }
            // Simulate periodic instance transitions to exercise the DPS tracker's reset.
            // Resend the roster/pet-ownership mapping right away too - a real client
            // gets a fresh burst of entity data immediately after entering a map, not
            // on some independent cadence, and waiting would leave a misleadingly
            // "unattributed" gap that doesn't reflect real play (instance changes
            // don't recur every few seconds like this fake loop's do).
            if (tick > 0 && tick % 40 == 0) {
                Register.INSTANCE.emitPacketLogs(mapInfo());
                if (!SKIP_CREATE_SUCCESS) Register.INSTANCE.emitPacketLogs(createSuccess());
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
                Register.INSTANCE.emitPacketLogs(enemyUpdate());
                Register.INSTANCE.emitPacketLogs(petOwnership());
            }
            // A NewTickPacket every tick, like a real client. It carries the
            // server clock the DPS engine uses as its time base - without it the
            // engine can't measure fight duration, so every computed DPS is 0.
            Register.INSTANCE.emitPacketLogs(newTick(tick));
            // The local player firing then landing a hit, every tick like a real
            // client during sustained fire: the outgoing PlayerShoot creates the
            // projectile (its damage computed from the weapon + player stats), and
            // the matching EnemyHit (same bulletId) applies it. This is the actual
            // self-DPS path, and EnemyHitPacket.mainID also identifies the local
            // player. Swap targets every ~20 ticks to exercise focus switching.
            short bulletId = (short) (tick % 100);
            int target = ENEMY_IDS[(tick / 20) % ENEMY_IDS.length];
            Register.INSTANCE.emitPacketLogs(localPlayerShoot(bulletId));
            Register.INSTANCE.emitPacketLogs(localPlayerHit(target, bulletId));
            Register.INSTANCE.emitPacketLogs(randomDamage());
            tick++;
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    /** Assigns the local-player identity to the first roster member, same as a real CreateSuccessPacket. */
    private CreateSuccessPacket createSuccess() {
        CreateSuccessPacket p = new CreateSuccessPacket();
        p.objectId = LOCAL_PLAYER_ID;
        p.charId = 1;
        p.str = "";
        return p;
    }

    /**
     * The local player landing a hit on an enemy - an outgoing packet a real
     * client sends on every one of its own hits. mainID (and shooterID, for a
     * direct player shot) is the local player's objectId; targetId is the enemy.
     */
    private EnemyHitPacket localPlayerHit(int target, short bulletId) {
        EnemyHitPacket p = new EnemyHitPacket();
        p.time = 0;
        p.bulletId = bulletId;
        p.shooterID = LOCAL_PLAYER_ID;
        p.targetId = target;
        p.kill = false;
        p.mainID = LOCAL_PLAYER_ID;
        return p;
    }

    /** The local player firing WEAPON_ID - the outgoing packet the engine turns into a damage-carrying projectile. */
    private PlayerShootPacket localPlayerShoot(short bulletId) {
        PlayerShootPacket p = new PlayerShootPacket();
        p.time = 0;
        p.bulletId = bulletId;
        p.weaponId = WEAPON_ID;
        p.projectileId = 0;
        p.startingPos = new WorldPosData();
        p.angle = 0;
        p.isBurst = false;
        p.patternIdx = 0;
        p.attackType = 0;
        p.playerPosition = new WorldPosData();
        return p;
    }

    /** A NewTickPacket carrying an advancing server clock (~300ms/tick), the engine's time base. */
    private NewTickPacket newTick(int tick) {
        NewTickPacket p = new NewTickPacket();
        p.tickId = tick;
        p.tickTime = 300;
        p.serverRealTimeMS = tick * 300;
        p.serverLastTimeRTTMS = 0;
        p.status = new ObjectStatusData[0];
        return p;
    }

    /** Establishes that PET_ID is a summon owned by the local player. */
    private ServerPlayerShootPacket petOwnership() {
        ServerPlayerShootPacket p = new ServerPlayerShootPacket();
        p.bulletId = 0;
        p.ownerId = PET_ID;
        p.containerType = 0;
        p.startingPos = new WorldPosData();
        p.angle = 0;
        p.damage = 0;
        p.summonerId = LOCAL_PLAYER_ID;
        return p;
    }

    /** A one-time UpdatePacket introducing a stable roster of named fake players. */
    private UpdatePacket rosterUpdate() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        p.newObjects = new ObjectData[ROSTER_IDS.length];
        for (int i = 0; i < ROSTER_IDS.length; i++) {
            ObjectStatusData status = new ObjectStatusData();
            status.objectId = ROSTER_IDS[i];
            status.pos = new WorldPosData();
            // Give the local player an equipped skin + 4 inventory slots so the
            // overlay's Character panel has something to render.
            status.stats = ROSTER_IDS[i] == LOCAL_PLAYER_ID
                ? localPlayerStats(ROSTER_NAMES[i])
                : playerStats(ROSTER_NAMES[i]);

            ObjectData obj = new ObjectData();
            obj.objectType = 0x0300; // player class 768, matches the synthetic players.xml
            obj.status = status;
            p.newObjects[i] = obj;
        }
        return p;
    }

    /** A numeric stat entry. */
    private static StatData stat(StatType type, int value) {
        StatData s = new StatData();
        s.statTypeNum = type.get();
        s.statType = type;
        s.statValue = value;
        s.statValueTwo = -1;
        return s;
    }

    /**
     * A realistic player stat block. The DPS engine reads the full base+boost
     * stat set (Entity.calculateBaseStats) plus ATTACK/CONDITION/exalt for the
     * damage multiplier, so a real client always sends all of these - the fake
     * source must too or the engine can't compute a maxed player's damage.
     */
    private StatData[] playerStats(String name) {
        StatData nameStat = new StatData();
        nameStat.statTypeNum = StatType.NAME_STAT.get();
        nameStat.statType = StatType.NAME_STAT;
        nameStat.stringStatValue = name;
        nameStat.statValueTwo = -1;
        return new StatData[]{
            nameStat,
            stat(StatType.MAX_HP_STAT, 770), stat(StatType.HP_STAT, 770),
            stat(StatType.MAX_MP_STAT, 252), stat(StatType.MP_STAT, 252),
            stat(StatType.ATTACK_STAT, 75), stat(StatType.DEFENSE_STAT, 25),
            stat(StatType.SPEED_STAT, 75), stat(StatType.DEXTERITY_STAT, 75),
            stat(StatType.VITALITY_STAT, 40), stat(StatType.WISDOM_STAT, 75),
            stat(StatType.CONDITION_STAT, 0), stat(StatType.NEW_CON_STAT, 0),
            stat(StatType.MAX_HP_BOOST_STAT, 0), stat(StatType.MAX_MP_BOOST_STAT, 0),
            stat(StatType.ATTACK_BOOST_STAT, 0), stat(StatType.DEFENSE_BOOST_STAT, 0),
            stat(StatType.SPEED_BOOST_STAT, 0), stat(StatType.DEXTERITY_BOOST_STAT, 0),
            stat(StatType.VITALITY_BOOST_STAT, 0), stat(StatType.WISDOM_BOOST_STAT, 0),
            stat(StatType.EXALTATION_BONUS_DAMAGE, 1000) // /1000 -> x1.0 multiplier
        };
    }

    /**
     * The local player's stat block, extended with an equipped skin (SKIN_ID) and
     * the 4 equipped slots (INVENTORY_0..3), so the overlay's Character panel can
     * render the player's sprite + loadout. Same shape a real client sends.
     */
    private StatData[] localPlayerStats(String name) {
        StatData[] base = playerStats(name);
        StatData[] extra = {
            stat(StatType.SKIN_ID, LOCAL_SKIN_ID),
            stat(StatType.INVENTORY_0_STAT, LOCAL_EQUIPMENT[0]),
            stat(StatType.INVENTORY_1_STAT, LOCAL_EQUIPMENT[1]),
            stat(StatType.INVENTORY_2_STAT, LOCAL_EQUIPMENT[2]),
            stat(StatType.INVENTORY_3_STAT, LOCAL_EQUIPMENT[3]),
            // Clothing (Tex1) / accessory (Tex2) dyes, as dye objectTypes, so the
            // dye tracking + compositing path is exercised in fake mode too.
            stat(StatType.TEX1_STAT, 4149),
            stat(StatType.TEX2_STAT, 4967)
        };
        StatData[] all = new StatData[base.length + extra.length];
        System.arraycopy(base, 0, all, 0, base.length);
        System.arraycopy(extra, 0, all, base.length, extra.length);
        return all;
    }

    /** Enemy stat block: what the defense/condition damage calc reads. */
    private StatData[] enemyStats() {
        return new StatData[]{
            stat(StatType.MAX_HP_STAT, 20000), stat(StatType.HP_STAT, 20000),
            stat(StatType.DEFENSE_STAT, 0),
            stat(StatType.CONDITION_STAT, 0), stat(StatType.NEW_CON_STAT, 0)
        };
    }

    /**
     * Introduces the two fake enemies as map objects carrying an objectType but
     * no NAME_STAT, exactly as the real client sees a monster. The bridge's
     * ObjectNames resolver turns their objectType into a display name so the
     * DPS panel can show a readable target instead of the raw id.
     */
    private UpdatePacket enemyUpdate() {
        UpdatePacket p = new UpdatePacket();
        p.levelType = 0;
        p.pos = new WorldPosData();
        p.tiles = new GroundTileData[0];
        p.drops = new int[0];

        p.newObjects = new ObjectData[ENEMY_IDS.length];
        for (int i = 0; i < ENEMY_IDS.length; i++) {
            ObjectStatusData status = new ObjectStatusData();
            status.objectId = ENEMY_IDS[i];
            status.pos = new WorldPosData();
            status.stats = enemyStats(); // no NAME_STAT: named via objectType

            ObjectData obj = new ObjectData();
            obj.objectType = ENEMY_TYPES[i];
            obj.status = status;
            p.newObjects[i] = obj;
        }
        return p;
    }

    /** A fake instance transition, to test that the DPS tracker resets on MapInfoPacket. */
    private MapInfoPacket mapInfo() {
        mapNumber++;
        MapInfoPacket p = new MapInfoPacket();
        p.width = 64;
        p.height = 64;
        p.name = "FakeRealm" + mapNumber;
        p.displayName = "Fake Realm " + mapNumber;
        p.realmName = p.displayName;
        p.versionNumber = "0";
        return p;
    }

    /**
     * A damage hit against a random fake enemy, attributed to a random member of
     * the fake roster - or, ~1 in 5 hits, to the fake pet (PET_ID), to exercise
     * minion-damage attribution redirecting it back to the local player.
     */
    private DamagePacket randomDamage() {
        int attacker = rng.nextInt(5) == 0 ? PET_ID : ROSTER_IDS[rng.nextInt(ROSTER_IDS.length)];
        int target = ENEMY_IDS[rng.nextInt(ENEMY_IDS.length)];

        DamagePacket p = new DamagePacket();
        p.targetId = target;
        p.effects = new int[0];
        p.damageAmount = 50 + rng.nextInt(450);
        p.damageProperties = rng.nextBoolean();
        p.bulletId = rng.nextInt(256);
        p.objectId = attacker;
        return p;
    }
}
