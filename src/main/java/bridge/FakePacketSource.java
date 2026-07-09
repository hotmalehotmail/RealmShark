package bridge;

import packets.data.GroundTileData;
import packets.data.ObjectData;
import packets.data.ObjectStatusData;
import packets.data.StatData;
import packets.data.WorldPosData;
import packets.data.enums.StatType;
import packets.incoming.DamagePacket;
import packets.incoming.UpdatePacket;
import packets.packetcapture.register.Register;

import java.util.Random;

/**
 * Debug packet source. Emits synthetic packets through the same {@link Register}
 * pipeline the real sniffer uses, so the bridge and any UI can be developed
 * without the game or Npcap running. Enabled with the {@code --fake} flag.
 * <p>
 * Emits a stable fake player roster once (via an {@link UpdatePacket} carrying
 * NAME_STAT, same shape a real client sees on entering a map), then loops
 * {@link DamagePacket}s attributed to that roster so a DPS meter has
 * consistent player identities to attribute hits to, not just random ids.
 */
public class FakePacketSource {

    private static final int[] ROSTER_IDS = {1, 2, 3, 4};
    private static final String[] ROSTER_NAMES = {"Alice", "Bob", "Carol", "Dave"};

    private final Random rng = new Random();

    /** Start emitting fake packets on a background daemon thread. */
    public void start() {
        Thread t = new Thread(this::loop, "fake-packet-source");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        int tick = 0;
        while (!Thread.currentThread().isInterrupted()) {
            // Resend the roster periodically (real UpdatePackets only arrive once per
            // object's render-visibility change) so a client that connects even a
            // moment late still picks up names within a few seconds, not never.
            if (tick % 15 == 0) {
                Register.INSTANCE.emitPacketLogs(rosterUpdate());
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

    /** A damage hit attributed to a random member of the fake roster. */
    private DamagePacket randomDamage() {
        int attacker = ROSTER_IDS[rng.nextInt(ROSTER_IDS.length)];

        DamagePacket p = new DamagePacket();
        p.targetId = 100_000; // fake enemy, shared by all hits
        p.effects = new int[0];
        p.damageAmount = 50 + rng.nextInt(450);
        p.damageProperties = rng.nextBoolean();
        p.bulletId = rng.nextInt(256);
        p.objectId = attacker;
        return p;
    }
}
