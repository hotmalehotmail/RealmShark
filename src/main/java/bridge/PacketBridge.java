package bridge;

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
 *   --port &lt;n&gt;  port to listen on (default 8080)
 *   --fake      emit synthetic packets instead of sniffing (no game/Npcap needed)
 * </pre>
 */
public class PacketBridge {

    private static final int DEFAULT_PORT = 8080;
    private static final int QUEUE_CAPACITY = 5000;   // drop-oldest guard so capture never blocks
    private static final long FLUSH_INTERVAL_MS = 33; // ~30 flushes/sec batch cadence

    private final BridgeServer server;
    private final PacketSerializer serializer = new PacketSerializer();
    private final BlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);

    public PacketBridge(int port) {
        server = new BridgeServer(port);
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
        // 1. Receive every decoded packet on the sniffer thread; serialize + enqueue.
        Register.INSTANCE.registerAll(packet -> {
            String json = serializer.toJson(packet);
            if (!queue.offer(json)) {
                // Queue full: drop oldest to keep capture non-blocking.
                queue.poll();
                queue.offer(json);
            }
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

        // 4. Start the packet source.
        if (fake) {
            System.out.println("[bridge] running in FAKE mode (no sniffing)");
            new FakePacketSource().start();
        } else {
            System.out.println("[bridge] starting sniffer (requires Npcap + running game)");
            new PacketProcessor().start();
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
