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
import packets.incoming.ServerPlayerShootPacket;
import packets.incoming.UpdatePacket;
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
 * pet owned by the local player (to exercise minion-damage attribution), and
 * loops {@link DamagePacket}s against two distinct fake enemies attributed
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

    // A fake pet owned by the local player, to exercise minion-damage attribution.
    private static final int PET_ID = 50;

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
        Register.INSTANCE.emitPacketLogs(createSuccess());
        while (!Thread.currentThread().isInterrupted()) {
            // Resend the roster and pet-ownership mapping periodically (real
            // UpdatePackets/ServerPlayerShootPackets only arrive on specific
            // events) so a client that connects even a moment late still picks
            // them up within a few seconds, not never.
            if (tick % 15 == 0) {
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
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
                Register.INSTANCE.emitPacketLogs(createSuccess());
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
                Register.INSTANCE.emitPacketLogs(petOwnership());
            }
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
            StatData nameStat = new StatData();
            nameStat.statTypeNum = StatType.NAME_STAT.get();
            nameStat.statType = StatType.NAME_STAT;
            nameStat.stringStatValue = ROSTER_NAMES[i];
            nameStat.statValueTwo = -1;

            ObjectStatusData status = new ObjectStatusData();
            status.objectId = ROSTER_IDS[i];
            status.pos = new WorldPosData();
            status.stats = new StatData[]{nameStat};

            ObjectData obj = new ObjectData();
            obj.objectType = 0x0300; // arbitrary player-class-ish id, not read by the UI
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
