package bridge.replay;

import bridge.DpsBroadcaster;
import bridge.dps.EngineClock;
import com.google.gson.Gson;
import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.zip.GZIPInputStream;
import packets.Packet;
import packets.PacketType;
import packets.packetcapture.register.IPacketListener;
import packets.packetcapture.register.Register;

/**
 * Test-side harness that loads a committed capture fixture (the same files
 * {@code overlay/test/replay.ts} consumes) and replays its packet envelopes back through the
 * real Java pipeline ({@link Register} to {@link DpsBroadcaster}/{@code DpsEngine}), so a
 * bridge-side attribution bug can be reproduced and regression-tested headlessly instead of by
 * hand-transcribing packets. See {@code docs/dps-engine.md} ("Capture replay (Java)") for the
 * full contract this mirrors.
 *
 * <p>Production code must never depend on this class - it lives in {@code src/test/java} only.
 */
public final class CaptureReplay {

    private CaptureReplay() {}

    private static final Gson GSON = new Gson();

    /**
     * Envelope types the bridge itself synthesizes (asset caches, computed DPS snapshots) -
     * these are pipeline *output*, never valid input to feed back through {@link Register}.
     */
    private static final Set<String> SYNTHESIZED_TYPES = new HashSet<>(Arrays.asList(
        "dps", "lootBagTypes", "objectNames", "itemInfo", "enchantNames"));

    private static final Map<String, Class<? extends Packet>> CLASS_BY_TYPE = buildClassByType();

    private static Map<String, Class<? extends Packet>> buildClassByType() {
        Map<String, Class<? extends Packet>> map = new HashMap<>();
        for (PacketType pt : PacketType.values()) {
            map.put(pt.getPacketClass().getSimpleName(), pt.getPacketClass());
        }
        return Collections.unmodifiableMap(map);
    }

    /** One decoded envelope, mirroring the TS {@code PacketEnvelope} shape verbatim. */
    public static final class PacketEnvelope {
        public String type;
        public String direction;
        public long time;
        public JsonElement data;
    }

    /** Bug-report capture shape ({@code {recentPackets: [...]}}) - see {@code loadCapture}. */
    private static final class CaptureFile {
        List<PacketEnvelope> recentPackets;
    }

    /** Outcome of a {@link #replay} call: how many envelopes were fed vs. skipped, and why. */
    public static final class ReplayStats {
        public int fed;
        public int skippedSynthesized;
        public int skippedUnknown;
        public final Map<String, Integer> unknownTypeCounts = new TreeMap<>();

        @Override
        public String toString() {
            return "ReplayStats{fed=" + fed
                + ", skippedSynthesized=" + skippedSynthesized
                + ", skippedUnknown=" + skippedUnknown
                + ", unknownTypeCounts=" + unknownTypeCounts + "}";
        }
    }

    /**
     * Loads a capture fixture in either committed shape and returns its envelopes sorted by
     * {@code time} ascending - the Java mirror of {@code loadCapture} in
     * {@code overlay/test/replay.ts}.
     *
     * <p>Gzip is detected by the {@code .gz} extension or, failing that, the gzip magic bytes
     * (0x1f 0x8b), matching the TS harness's extension-or-magic-byte fallback. NDJSON (one
     * envelope per line, {@code .ndjson}/{@code .ndjson.gz}) is a session recording; anything
     * else is parsed as a single JSON document that is either a bare envelope array or a
     * bug-report {@code {recentPackets: [...]}} object.
     */
    public static List<PacketEnvelope> loadCapture(Path path) throws IOException {
        byte[] raw = Files.readAllBytes(path);
        boolean gzip = path.toString().endsWith(".gz") || isGzipMagic(raw);
        String text = new String(gzip ? gunzip(raw) : raw, StandardCharsets.UTF_8);

        String name = path.toString();
        boolean ndjson = name.endsWith(".ndjson") || name.endsWith(".ndjson.gz");

        List<PacketEnvelope> envelopes = new ArrayList<>();
        if (ndjson) {
            for (String line : text.split("\n", -1)) {
                if (line.trim().isEmpty()) continue;
                envelopes.add(GSON.fromJson(line, PacketEnvelope.class));
            }
        } else {
            JsonElement parsed = JsonParser.parseString(text);
            if (parsed.isJsonArray()) {
                for (JsonElement e : parsed.getAsJsonArray()) {
                    envelopes.add(GSON.fromJson(e, PacketEnvelope.class));
                }
            } else {
                CaptureFile file = GSON.fromJson(parsed, CaptureFile.class);
                if (file.recentPackets != null) envelopes.addAll(file.recentPackets);
            }
        }
        envelopes.sort(Comparator.comparingLong(e -> e.time));
        return envelopes;
    }

    private static boolean isGzipMagic(byte[] raw) {
        return raw.length >= 2 && (raw[0] & 0xff) == 0x1f && (raw[1] & 0xff) == 0x8b;
    }

    private static byte[] gunzip(byte[] raw) throws IOException {
        try (GZIPInputStream in = new GZIPInputStream(new ByteArrayInputStream(raw));
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    /**
     * Deserializes one envelope's {@code data} into the concrete {@link Packet} subclass named
     * by its {@code type} (the packet class's simple name, per
     * {@code PacketSerializer.toJson}) - or returns {@code null} if the type should be skipped
     * (counted on {@code stats}), never throwing on an unknown/synthesized type.
     */
    private static Packet toPacket(PacketEnvelope env, ReplayStats stats) {
        if (SYNTHESIZED_TYPES.contains(env.type)) {
            stats.skippedSynthesized++;
            return null;
        }
        Class<? extends Packet> clazz = CLASS_BY_TYPE.get(env.type);
        if (clazz == null) {
            stats.skippedUnknown++;
            stats.unknownTypeCounts.merge(env.type, 1, Integer::sum);
            return null;
        }
        return GSON.fromJson(env.data, clazz);
    }

    /**
     * Replays every envelope through the real {@link Register}/{@link DpsBroadcaster} pipeline,
     * anchoring {@link EngineClock} to each envelope's own recorded {@code time} before feeding
     * it (the Java analog of the TS harness's {@code vi.setSystemTime} per-envelope anchoring),
     * so fight-duration/DPS-rate math sees the capture's original timeline instead of the
     * replay's real wall-clock time. Equivalent to {@code replayUntil(envelopes, broadcaster,
     * Long.MAX_VALUE)}.
     */
    public static ReplayStats replay(List<PacketEnvelope> envelopes, DpsBroadcaster broadcaster) {
        return replayUntil(envelopes, broadcaster, Long.MAX_VALUE);
    }

    /**
     * Like {@link #replay}, but stops after the last envelope with {@code time <= untilMs} -
     * the Java analog of {@code replayUntil} in {@code overlay/test/replay.ts}. Useful for
     * comparing engine state at a specific instant (e.g. a recorded {@code dps} snapshot's own
     * time) against that snapshot, without replaying packets recorded after it.
     */
    public static ReplayStats replayUntil(
        List<PacketEnvelope> envelopes, DpsBroadcaster broadcaster, long untilMs
    ) {
        ReplayStats stats = new ReplayStats();
        long[] clock = {0L};
        EngineClock.set(() -> clock[0]);
        IPacketListener<Packet> listener = broadcaster::feed;
        Register.INSTANCE.registerAll(listener);
        try {
            for (PacketEnvelope env : envelopes) {
                if (env.time > untilMs) break;
                clock[0] = env.time;
                Packet packet = toPacket(env, stats);
                if (packet != null) {
                    Register.INSTANCE.emitPacketLogs(packet);
                    stats.fed++;
                }
            }
        } finally {
            Register.INSTANCE.unregisterAll(listener);
            EngineClock.reset();
        }
        return stats;
    }
}
