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
 *   --port &lt;n&gt;      port to listen on (default 47474)
 *   --fake          emit synthetic packets instead of sniffing (no game/Npcap needed)
 * </pre>
 */
public class PacketBridge {

    private static final int DEFAULT_PORT = 47474;
    private static final int QUEUE_CAPACITY = 5000;   // drop-oldest guard so capture never blocks
    private static final long FLUSH_INTERVAL_MS = 33; // ~30 flushes/sec batch cadence
    private static final long DPS_INTERVAL_MS = 250;  // heartbeat DPS-snapshot cadence
    private static final long DPS_COALESCE_MS = 50;   // min gap between damage-triggered snapshots

    private final BridgeServer server;
    private final PacketSerializer serializer = new PacketSerializer();
    private final ObjectNames objectNames = new ObjectNames();
    private final DpsBroadcaster dps = new DpsBroadcaster();
    private final SpritePackService sprites = new SpritePackService();
    private final LootBagTypes lootBagTypes = new LootBagTypes();
    private final ItemInfo itemInfo = new ItemInfo();
    private final EnchantNames enchantNames = new EnchantNames();
    private final BlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
    // Set on the sniffer thread when a damage packet lands, so the DPS scheduler
    // pushes a fresh snapshot within DPS_COALESCE_MS instead of waiting a full tick.
    private volatile boolean dpsDirty = false;
    private volatile long lastDpsSendMs = 0;

    public PacketBridge(int port) {
        server = new BridgeServer(port);
        server.setMessageHandler(this::handleClientMessage);
        server.setConnectListener(this::sendMetadataTo);
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
            // stream); snapshots are emitted by the scheduler below. Mark dirty
            // on a damage packet so that scheduler pushes an update promptly.
            if (dps.feed(packet)) dpsDirty = true;
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

        // Emit computed-DPS snapshots: promptly (within DPS_COALESCE_MS) after a
        // damage packet so total-damage numbers feel real-time, and otherwise as
        // a heartbeat every DPS_INTERVAL_MS so the fight-average DPS keeps
        // trending as the fight timer grows. Coalesced so a burst of damage
        // packets can't flood the socket.
        flusher.scheduleAtFixedRate(() -> {
            long now = System.currentTimeMillis();
            boolean heartbeat = now - lastDpsSendMs >= DPS_INTERVAL_MS;
            if (!dpsDirty && !heartbeat) return;
            dpsDirty = false;
            lastDpsSendMs = now;
            String json = dps.snapshotJson();
            if (json != null) enqueue(json);
        }, DPS_COALESCE_MS, DPS_COALESCE_MS, TimeUnit.MILLISECONDS);

        // Periodic engine diagnostic (every ~3s) so the Console panel shows why
        // self-DPS may be missing: worldPlayerId/player resolution + shoot/hit counts.
        flusher.scheduleAtFixedRate(
            () -> System.out.println("[dps-engine] " + dps.debugState()),
            3000, 3000, TimeUnit.MILLISECONDS);

        // Assets extract/load on a background thread, so they usually aren't
        // ready when a client first connects and requests the sprite pack.
        // Watch for readiness and broadcast the pack once, so clients that got
        // an early not-ready reply still receive the real sprites.
        flusher.scheduleAtFixedRate(
            this::maybeBroadcastSpritePack, 2000, 2000, TimeUnit.MILLISECONDS);

        // Metadata tables (loot BagTypes, item info, enchant names) are
        // delivered edge-triggered, never periodically (issue #239: the old
        // "re-broadcast forever, the payload is tiny" shortcut silently became
        // a ~630 KB lootBagTypes push every 2s once issue #217 widened that
        // table to all bag colors, costing every client a parse + full table
        // rebuild per tick). This poll only DETECTS two of the three delivery
        // edges - the not-ready -> ready transition and a content change
        // (re-extraction) - by comparing each table's cheap version key
        // against the last one broadcast; an unchanged version sends nothing.
        // The third edge, a client connecting after readiness, is handled
        // per-connection in sendMetadataTo (BridgeServer's connect listener).
        flusher.scheduleAtFixedRate(
            this::maybeBroadcastMetadata, 2000, 2000, TimeUnit.MILLISECONDS);

        // 4. Start the packet source.
        if (fake) {
            System.out.println("[bridge] running in FAKE mode (no sniffing)");
            new FakePacketSource().start();
        } else {
            System.out.println("[bridge] starting sniffer (requires Npcap + running game)");
            new PacketProcessor().start();
        }
    }

    private boolean spritePackSent = false;
    private int spriteNotReadyLogs = 0;

    /**
     * Once assets finish loading, broadcast the full sprite pack to every client
     * (a one-shot). Until then, log the not-ready state a few times so the
     * Console panel shows whether assets extracted at all.
     */
    private void maybeBroadcastSpritePack() {
        if (spritePackSent) return;
        if (sprites.ready()) {
            spritePackSent = true;
            server.send(sprites.responseFor(null));
            System.out.println("[bridge] sprite pack ready " + sprites.version()
                + " - broadcast to clients");
        } else if (spriteNotReadyLogs < 6) {
            spriteNotReadyLogs++;
            System.out.println("[bridge] sprite pack not ready yet (" + sprites.diagnostic() + ")");
        }
    }

    // Last version key broadcast per metadata table. Touched only on the
    // flusher thread (maybeBroadcastMetadata); the per-connection path
    // (sendMetadataTo, WS thread) deliberately doesn't read them - it always
    // sends the current tables to exactly one new client.
    private String sentLootVersion;
    private String sentItemInfoVersion;
    private String sentEnchantVersion;

    /**
     * Broadcasts each metadata table only when its content version differs
     * from the last one broadcast - i.e. on the not-ready -> ready transition
     * and on a re-extraction/reload, never merely because the poll fired
     * (issue #239). Version keys are cheap (a count read, no JSON built), so
     * the steady-state cost of this poll is three string compares.
     * <p>
     * A client that connects in the window between readiness and this poll's
     * next tick receives the tables twice (its own on-open copy, then this
     * first broadcast) - accepted: it's one duplicate per version transition
     * instead of one every 2s, and the renderer's metaVersion guard reduces
     * it to a string compare anyway.
     */
    private void maybeBroadcastMetadata() {
        if (lootBagTypes.ready()) {
            String v = lootBagTypes.version();
            if (!v.equals(sentLootVersion)) {
                sentLootVersion = v;
                enqueue(lootBagTypes.envelopeJson());
                System.out.println("[bridge] loot bag types " + v + " - broadcast to clients");
            }
        }
        if (itemInfo.ready()) {
            String v = itemInfo.version();
            if (!v.equals(sentItemInfoVersion)) {
                sentItemInfoVersion = v;
                enqueue(itemInfo.envelopeJson());
                System.out.println("[bridge] item info " + v + " - broadcast to clients");
            }
        }
        // No readiness gate (see EnchantNames' docstring) - its version key
        // moves from the near-empty pre-extraction table to the real one on
        // reload, and this comparison picks that up like any other change.
        String ev = enchantNames.version();
        if (!ev.equals(sentEnchantVersion)) {
            sentEnchantVersion = ev;
            enqueue(enchantNames.envelopeJson());
        }
    }

    /**
     * The third delivery edge (issue #239): a client connecting after a table
     * became ready would otherwise never see it, now that the periodic
     * re-broadcast is gone. Sends the current tables straight to the new
     * connection as one batch frame (clients only parse hello and
     * {@code {"batch":[...]}} messages), bypassing the shared queue so the
     * tables can't be duplicated to already-served clients. Runs on the WS
     * server thread - the table getters are synchronized and normally just
     * return their cached JSON.
     */
    private void sendMetadataTo(WebSocket conn) {
        List<String> envelopes = new ArrayList<>();
        if (lootBagTypes.ready()) envelopes.add(lootBagTypes.envelopeJson());
        if (itemInfo.ready()) envelopes.add(itemInfo.envelopeJson());
        envelopes.add(enchantNames.envelopeJson());
        conn.send(batchOf(envelopes));
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
        server.send(batchOf(drained));
    }

    /** Joins already-serialized JSON objects into one {@code {"batch":[...]}} frame. */
    private static String batchOf(List<String> envelopes) {
        StringBuilder sb = new StringBuilder("{\"batch\":[");
        for (int i = 0; i < envelopes.size(); i++) {
            if (i > 0) sb.append(',');
            sb.append(envelopes.get(i));
        }
        sb.append("]}");
        return sb.toString();
    }
}
