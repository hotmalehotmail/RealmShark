package bridge;

import com.google.gson.ExclusionStrategy;
import com.google.gson.FieldAttributes;
import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import packets.Packet;
import packets.PacketType;

import java.util.Arrays;
import java.util.HashSet;
import java.util.Set;

/**
 * Converts decoded {@link Packet} objects into the JSON envelope broadcast to
 * WebSocket clients. Envelope shape:
 * <pre>
 * { "type": "DamagePacket", "direction": "incoming", "time": 1720..., "data": { ...packet fields... } }
 * </pre>
 * The raw {@code byte[]} payload carried on the base {@link Packet} class is
 * excluded - it is noise for a UI and bloats every message.
 *
 * <p>Login/device credentials ({@link #SENSITIVE_FIELDS}, all carried on
 * {@code HelloPacket}) are also stripped from every serialized packet. They have
 * no UI or repro value, and must never reach a client - nor the "Report bug"
 * capture, which users attach to public issues. Matched by field name (not class)
 * so any future packet carrying one is covered too.</p>
 */
public class PacketSerializer {

    /** Credential/device-token field names stripped from every serialized packet. */
    private static final Set<String> SENSITIVE_FIELDS = new HashSet<>(Arrays.asList(
            "accessToken", "platformToken", "clientToken", "userToken", "password"));

    private final Gson gson;
    private final Set<Integer> incomingIndices;

    public PacketSerializer() {
        ExclusionStrategy skipSensitive = new ExclusionStrategy() {
            @Override
            public boolean shouldSkipField(FieldAttributes f) {
                // Raw undecoded payload on the base Packet class: noise for a UI.
                if (f.getDeclaringClass() == Packet.class && "data".equals(f.getName())) {
                    return true;
                }
                // Login/device credentials: never serialize these anywhere.
                return SENSITIVE_FIELDS.contains(f.getName());
            }

            @Override
            public boolean shouldSkipClass(Class<?> clazz) {
                return false;
            }
        };
        gson = new GsonBuilder()
                .addSerializationExclusionStrategy(skipSensitive)
                .create();
        incomingIndices = new HashSet<>(Arrays.asList(PacketType.getPacketTypeByDirection(true)));
    }

    /**
     * Serialize a single packet into a JSON envelope string.
     *
     * @param packet decoded packet emitted by the registry.
     * @return JSON envelope ready to send over the wire.
     */
    public String toJson(Packet packet) {
        Envelope env = new Envelope();
        env.type = packet.getClass().getSimpleName();
        env.direction = directionOf(packet);
        env.time = System.currentTimeMillis();
        env.data = packet;
        return gson.toJson(env);
    }

    private String directionOf(Packet packet) {
        PacketType pt = PacketType.byClass(packet);
        if (pt == null) return "unknown";
        return incomingIndices.contains(pt.getIndex()) ? "incoming" : "outgoing";
    }

    /** JSON envelope written to clients. Field names here are the wire protocol. */
    private static final class Envelope {
        String type;
        String direction;
        long time;
        Packet data;
    }
}
