package packets.packetcapture.register;

import packets.Packet;
import packets.PacketType;
import packets.packetcapture.logger.PacketLogger;
import util.Pair;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;

/**
 * The registry class is used to subscribe to either all or specific packets. If registered packets
 * are received the emit method will send an update and trigger the lambda used.
 */
public class Register {
    public static final Register INSTANCE = new Register();
    private final HashMap<Class<? extends Packet>, ArrayList<IPacketListener<Packet>>> packetListeners = new HashMap<>();
    private boolean emitting = false;
    private final ArrayList<Pair<ArrayList<IPacketListener<Packet>>, IPacketListener<Packet>>> remove = new ArrayList<>();
    private static List<Subscriber> subscribePacketLogs = new ArrayList<>();

    /**
     * Emitter for sending packets to any subscriber which matches the packets the subscriber have subbed too.
     *
     * @param packet The packet being received and emitted.
     */
    public void emitPacketLogs(Packet packet) {
        emitting = true;
        if (packetListeners.containsKey(packet.getClass())) {
            for (IPacketListener<Packet> processor : packetListeners.get(packet.getClass()))
                processor.process(packet);
        }

        if (packetListeners.containsKey(Packet.class)) {
            for (IPacketListener<Packet> processor : packetListeners.get(Packet.class))
                processor.process(packet);
        }
        emitting = false;

        if (!remove.isEmpty()) {
            for (Pair<ArrayList<IPacketListener<Packet>>, IPacketListener<Packet>> p : remove) {
                p.left().remove(p.right());
            }
            remove.clear();
        }
    }

    /**
     * Register method to subscribe to packets that are being received from the network tap.
     *
     * @param type      The type of class wanting to be subscribed too.
     * @param processor The lambda needed to trigger what event should happen if packet is received.
     * @param <T>       Class type.
     */
    public <T extends Class<? extends Packet>> void register(PacketType type, IPacketListener<Packet> processor) {
        packetListeners.computeIfAbsent(type.getPacketClass(), (a) -> new ArrayList<>()).add(processor);
    }

    /**
     * Register method to subscribe to all packets that are being received from the network tap.
     *
     * @param processor The lambda needed to trigger what event should happen if packet is received.
     * @param <T>       Class type.
     */
    public <T extends Class<? extends Packet>> void registerAll(IPacketListener<Packet> processor) {
        packetListeners.computeIfAbsent(Packet.class, (a) -> new ArrayList<>()).add(processor);
    }

    /**
     * Removes a registered method and stops the method receiving network packets.
     *
     * @param type      The type of class wanting to be un-subscribed from.
     * @param processor The lambda needed to identify what method to unregister.
     * @return True if the removal is successful.
     */
    public boolean unregister(PacketType type, IPacketListener<Packet> processor) {
        return unregisterFrom(type.getPacketClass(), processor);
    }

    /**
     * Removes a processor registered via {@link #registerAll(IPacketListener)}. Symmetric
     * counterpart to {@code unregister}, needed by anything (e.g. a test harness replaying a
     * capture) that registers a scoped catch-all listener and must detach it afterward instead
     * of leaking it for the rest of the JVM's lifetime.
     *
     * @param processor The lambda passed to {@link #registerAll(IPacketListener)}.
     * @return True if the removal is successful.
     */
    public boolean unregisterAll(IPacketListener<Packet> processor) {
        return unregisterFrom(Packet.class, processor);
    }

    private boolean unregisterFrom(Class<? extends Packet> key, IPacketListener<Packet> processor) {
        ArrayList<IPacketListener<Packet>> list = packetListeners.get(key);
        if (list != null) {
            if (list.size() == 1) {
                return packetListeners.remove(key) != null;
            } else if (!emitting) {
                return list.remove(processor);
            } else if (list.contains(processor)) {
                remove.add(new Pair<>(list, processor));
                return true;
            }
        }
        return false;
    }

    /**
     * Subscription to logger for incoming and outgoing packets.
     * Example: PacketLogger.subscribe(e->logOut(e));
     * logOut(String logs) being a method that prints the logs.
     *
     * @param sub Interface for subscription used in lambda.
     */
    public void subscribePacketLogger(Subscriber sub) {
        subscribePacketLogs.add(sub);
    }

    /**
     * Emits the logs to any subscriber.
     */
    public void emitLogs(PacketLogger logger) {
        for (Subscriber sub : subscribePacketLogs) {
            sub.receive(logger.toString());
        }
    }

    public interface Subscriber {
        void receive(String msg);
    }
}
