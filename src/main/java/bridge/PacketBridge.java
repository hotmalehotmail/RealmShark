package bridge;

import bridge.sprites.SpritePackService;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.java_websocket.WebSocket;
import packets.incoming.UpdatePacket;
import packets.packetcapture.PacketProcessor;
import packets.packetcapture.register.Register;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.BlockingQueue;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * Entry point for the WebSocket bridge. Subscribes to every decoded packet from
 * the RealmShark sniffer, serializes it to JSON, and broadcasts batches to local
 * WebSocket clients (e.g. an overlay UI).
 * <p>
 * Packets are enqueued on the sniffer thread and flushed to clients on a fixed
 * cadence, so a slow or dead client can never stall packet capture. Batching one
 * WebSocket message per flush (rather than per packet) keeps message counts low
 * during dungeon bursts and aligns naturally with a UI render frame.
 *
 * <pre>
 * Usage: java bridge.PacketBridge [--port &lt;n&gt;] [--fake]
 *   --port &lt;n&gt;  port to listen on (default 47474)
 *   --fake      emit synthetic packets instead of sniffing (no game/Npcap needed)
 * </pre>
 */
public class PacketBridge {

    private static final int DEFAULT_PORT = 47474;
    private static final int QUEUE_CAPACITY = 5000;   // drop-oldest guard so capture never blocks
    private static final long FLUSH_INTERVAL_MS = 33; // ~30 flushes/sec batch cadence
    private static final long DPS_INTERVAL_MS = 500;  // computed-DPS snapshot cadence

    private final BridgeServer server;
    private final PacketSerializer serializer = new PacketSerializer();
    private final ObjectNames objectNames = new ObjectNames();
    private final DpsBroadcaster dps = new DpsBroadcaster();
    private final SpritePackService sprites = new SpritePackService();
    private final BlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);

    public PacketBridge(int port) {
        server = new BridgeServer(port);
        server.setMessageHandler(this::handleClientMessage);
    }

    /**
     * Handles a client -> bridge message. The only one today is the one-time
     * sprite-pack fetch: {@code {"type":"spritePackRequest","haveVersion":"..."}}.
     * The response is sent directly to the requesting client, not broadcast.
     */
    private void handleClientMessage(WebSocket conn, String message) {
        try {
            JsonElement parsed = JsonParser.parseString(message);
            if (!parsed.isJsonObject()) return;
            JsonObject obj = parsed.getAsJsonObject();
            JsonElement type = obj.get("type");
            if (type == null || !"spritePackRequest".equals(type.getAsString())) return;
            String have = obj.has("haveVersion") && !obj.get("haveVersion").isJsonNull()
                ? obj.get("haveVersion").getAsString() : null;
            conn.send(sprites.responseFor(have));
        } catch (Exception e) {
            System.err.println("[bridge] bad client message: " + e);
        }
    }

    public static void main(String[] args) {
        int port = DEFAULT_PORT;
        boolean fake = false;
        for (int i = 0; i < args.length; i++) {
            switch (args[i]) {
                case "--port":
                    port = Integer.parseInt(args[++i]);
                    break;
                case "--fake":
                    fake = true;
                    break;
                default:
                    System.err.println("[bridge] unknown argument: " + args[i]);
            }
        }
        new PacketBridge(port).start(fake);
    }

    private void start(boolean fake) {
        // 0. Load enemy/NPC name assets (off-thread, best-effort) so UpdatePackets
        //    can be annotated with human-readable object names.
        objectNames.init(fake);

        // 1. Receive every decoded packet on the sniffer thread; serialize + enqueue.
        //    UpdatePackets additionally emit a synthetic objectNames envelope so
        //    the overlay can name enemies it would otherwise only know by id.
        Register.INSTANCE.registerAll(packet -> {
            enqueue(serializer.toJson(packet));
            if (packet instanceof UpdatePacket) {
                String names = objectNames.envelopeFor((UpdatePacket) packet);
                if (names != null) enqueue(names);
            }
            // Feed the DPS engine (computes each player's damage from the same
            // stream); snapshots are emitted on a separate cadence below.
            dps.feed(packet);
        });

        // 2. Start the WebSocket server (spawns its own thread).
        server.start();

        // 3. Batch-flush the queue to clients on a fixed cadence.
        ScheduledExecutorService flusher = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "bridge-flusher");
            t.setDaemon(true);
            return t;
        });
        flusher.scheduleAtFixedRate(this::flush, FLUSH_INTERVAL_MS, FLUSH_INTERVAL_MS, TimeUnit.MILLISECONDS);

        // Emit a computed-DPS snapshot on a slower cadence (it aggregates the
        // whole fight, so 500ms is plenty and keeps message volume low).
        flusher.scheduleAtFixedRate(() -> {
            String json = dps.snapshotJson();
            if (json != null) enqueue(json);
        }, DPS_INTERVAL_MS, DPS_INTERVAL_MS, TimeUnit.MILLISECONDS);

        // Periodic engine diagnostic (every ~3s) so the Console panel shows why
        // self-DPS may be missing: worldPlayerId/player resolution + shoot/hit counts.
        flusher.scheduleAtFixedRate(
            () -> System.out.println("[dps-engine] " + dps.debugState()),
            3000, 3000, TimeUnit.MILLISECONDS);

        // 4. Start the packet source.
        if (fake) {
            System.out.println("[bridge] running in FAKE mode (no sniffing)");
            new FakePacketSource().start();
        } else {
            System.out.println("[bridge] starting sniffer (requires Npcap + running game)");
            new PacketProcessor().start();
        }
    }

    /** Enqueue a JSON message, dropping the oldest if the queue is full so capture never blocks. */
    private void enqueue(String json) {
        if (!queue.offer(json)) {
            queue.poll();
            queue.offer(json);
        }
    }

    /** Drain queued packet JSON and broadcast it as one batched message. */
    private void flush() {
        if (queue.isEmpty()) return;
        List<String> drained = new ArrayList<>();
        queue.drainTo(drained);
        if (drained.isEmpty()) return;
        // Items are already JSON objects; join them into a batch array.
        StringBuilder sb = new StringBuilder("{\"batch\":[");
        for (int i = 0; i < drained.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(drained.get(i));
        }
        sb.append("]}");
        server.send(sb.toString());
    }
}
