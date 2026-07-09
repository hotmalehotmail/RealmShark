package bridge;

import packets.incoming.DamagePacket;
import packets.packetcapture.register.Register;

import java.util.Random;

/**
 * Debug packet source. Emits synthetic packets through the same {@link Register}
 * pipeline the real sniffer uses, so the bridge and any UI can be developed
 * without the game or Npcap running. Enabled with the {@code --fake} flag.
 */
public class FakePacketSource {

    private final Random rng = new Random();

    /** Start emitting fake packets on a background daemon thread. */
    public void start() {
        Thread t = new Thread(this::loop, "fake-packet-source");
        t.setDaemon(true);
        t.start();
    }

    private void loop() {
        while (!Thread.currentThread().isInterrupted()) {
            Register.INSTANCE.emitPacketLogs(randomDamage());
            try {
                Thread.sleep(500);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private DamagePacket randomDamage() {
        DamagePacket p = new DamagePacket();
        p.targetId = rng.nextInt(100_000);
        p.effects = new int[0];
        p.damageAmount = rng.nextInt(1_000);
        p.damageProperties = rng.nextBoolean();
        p.bulletId = rng.nextInt(256);
        p.objectId = rng.nextInt(100_000);
        return p;
    }
}
