package bridge;

import assets.AssetExtractor;
import assets.IdToAsset;
import bridge.dps.enums.CharacterClass;
import com.google.gson.Gson;
import packets.data.ObjectData;
import packets.data.StatData;
import packets.data.enums.StatType;
import packets.incoming.UpdatePacket;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Resolves enemy/NPC object names from the extracted RotMG game assets so the
 * overlay can show a human-readable target instead of a raw object id.
 * <p>
 * Players are deliberately skipped here: they carry a NAME_STAT and the client
 * already names them from it. Every UpdatePacket introduces a fresh batch of
 * objects; for the non-player ones we look up objectType -> display name and
 * emit a synthetic {@code {"type":"objectNames","data":{"<objectId>":"<name>"}}}
 * envelope that the overlay merges into its id -> name registry. Because
 * {@code newObjects} only ever contains newly-appeared objects, this is
 * naturally deduplicated and stays cheap.
 */
public class ObjectNames {

    private static final int NAME_STAT_NUM = StatType.NAME_STAT.get();
    private final Gson gson = new Gson();

    /**
     * Loads object-name assets in the background (best-effort). In real mode it
     * first tries a headless extraction from the installed game client; in fake
     * mode it only reads whatever {@code assets/ObjectID.list} already exists on
     * disk. Any failure (game not installed, no assets, headless env) simply
     * leaves names unresolved so the overlay falls back to the object id - it
     * must never block or crash the bridge.
     *
     * @param fake whether the bridge is running with synthetic packets (no game).
     */
    public void init(boolean fake) {
        Thread t = new Thread(() -> {
            if (!fake) {
                try {
                    AssetExtractor.extractHeadless("bridge");
                    // CharacterClass's static initializer races this thread reading
                    // assets/xml/players.xml - if packet processing touched it before
                    // extraction finished, it cached empty data forever. Now that
                    // extraction has written the file, give it a chance to reload.
                    CharacterClass.reload();
                } catch (Throwable e) {
                    System.out.println("[bridge] asset extraction skipped: " + e);
                }
            }
            try {
                IdToAsset.reloadAssets();
                System.out.println(
                    "[bridge] loaded " + IdToAsset.loadedObjectCount() + " object names");
            } catch (Throwable e) {
                System.out.println("[bridge] object name load failed: " + e);
            }
        }, "asset-loader");
        t.setDaemon(true);
        t.start();
    }

    /**
     * Builds the objectNames envelope for a single UpdatePacket, or null if none
     * of its new objects resolve to a name (unresolved ids are simply omitted).
     *
     * @param p the UpdatePacket whose new objects should be named.
     * @return JSON envelope string, or null when there is nothing to send.
     */
    public String envelopeFor(UpdatePacket p) {
        if (p.newObjects == null) return null;
        Map<String, String> names = new LinkedHashMap<>();
        for (ObjectData obj : p.newObjects) {
            if (obj == null || obj.status == null) continue;
            if (hasNameStat(obj)) continue; // players are named client-side via NAME_STAT
            String name = IdToAsset.objectName(obj.objectType);
            if (name != null && !name.isEmpty()) {
                names.put(String.valueOf(obj.status.objectId), name);
            }
        }
        if (names.isEmpty()) return null;
        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = names;
        return gson.toJson(env);
    }

    private static boolean hasNameStat(ObjectData obj) {
        if (obj.status.stats == null) return false;
        for (StatData s : obj.status.stats) {
            if (s != null && s.statTypeNum == NAME_STAT_NUM) return true;
        }
        return false;
    }

    /** Envelope shape matching {@link PacketSerializer}'s, so overlay clients treat it uniformly. */
    private static final class Envelope {
        final String type = "objectNames";
        final String direction = "internal";
        long time;
        Map<String, String> data;
    }
}
