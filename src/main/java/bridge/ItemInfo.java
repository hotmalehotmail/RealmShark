package bridge;

import assets.IdToAsset;
import com.google.gson.Gson;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Resolves item metadata (display name, tier, class, description, weapon
 * damage range) for every loaded object id, from the extracted game assets
 * (or, in {@code --fake} bridge mode, the synthetic entries
 * {@link IdToAsset#registerFake} adds) - so the overlay's item tooltip
 * (issue #109) has more than just a sprite to show, with no hand-maintained
 * item database. Mirrors {@link LootBagTypes}'s shape and broadcast pattern:
 * a synthetic
 * {@code {"type":"itemInfo","data":{"names":{...},"tiers":{...},"classes":{...},"descriptions":{...},"minDamage":{...},"maxDamage":{...}}}}
 * envelope through the normal packet-batch stream, independent of the sprite
 * pack's atlas-readiness gate since this data needs no atlas.
 */
public class ItemInfo {

    private final Gson gson = new Gson();
    private String cachedJson;
    private int cachedObjectCount = -1;

    /** True once object assets (real or {@code --fake}-seeded) are loaded. */
    public boolean ready() {
        return IdToAsset.loadedObjectCount() > 1;
    }

    /** Content-version key - same contract as {@link LootBagTypes#version()} (issue #239). */
    public String version() {
        return "oc" + IdToAsset.loadedObjectCount();
    }

    /**
     * The envelope JSON, rebuilt only when the loaded object count changes (a
     * re-extraction/reload), so repeated polling is cheap.
     */
    public synchronized String envelopeJson() {
        int count = IdToAsset.loadedObjectCount();
        if (cachedJson != null && count == cachedObjectCount) return cachedJson;

        Map<String, String> names = new LinkedHashMap<>();
        Map<String, String> tiers = new LinkedHashMap<>();
        Map<String, String> classes = new LinkedHashMap<>();
        Map<String, String> descriptions = new LinkedHashMap<>();
        Map<String, Integer> minDamage = new LinkedHashMap<>();
        Map<String, Integer> maxDamage = new LinkedHashMap<>();

        for (int id : IdToAsset.objectIds()) {
            if (id <= 0) continue;

            String name = IdToAsset.objectName(id);
            if (name != null && !name.isEmpty()) names.put(String.valueOf(id), name);

            String tier = IdToAsset.getTier(id);
            if (tier != null && !tier.isEmpty()) tiers.put(String.valueOf(id), tier);

            String clazz = IdToAsset.getClazz(id);
            if (clazz != null && !clazz.isEmpty()) classes.put(String.valueOf(id), clazz);

            String description = IdToAsset.getDescription(id);
            if (description != null && !description.isEmpty()) {
                descriptions.put(String.valueOf(id), description);
            }

            // Weapon damage range, if this object has projectile data (slot 0 is
            // the primary projectile for every weapon type this project decodes).
            if (IdToAsset.getIdProjectileCount(id) > 0) {
                int min = IdToAsset.getIdProjectileMinDmg(id, 0);
                int max = IdToAsset.getIdProjectileMaxDmg(id, 0);
                if (min >= 0 && max >= 0) {
                    minDamage.put(String.valueOf(id), min);
                    maxDamage.put(String.valueOf(id), max);
                }
            }
        }

        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = new Data();
        env.data.metaVersion = "oc" + count;
        env.data.names = names;
        env.data.tiers = tiers;
        env.data.classes = classes;
        env.data.descriptions = descriptions;
        env.data.minDamage = minDamage;
        env.data.maxDamage = maxDamage;

        cachedJson = gson.toJson(env);
        cachedObjectCount = count;
        return cachedJson;
    }

    private static final class Data {
        String metaVersion;
        Map<String, String> names;
        Map<String, String> tiers;
        Map<String, String> classes;
        Map<String, String> descriptions;
        Map<String, Integer> minDamage;
        Map<String, Integer> maxDamage;
    }

    /** Envelope shape matching {@link PacketSerializer}'s, so overlay clients treat it uniformly. */
    private static final class Envelope {
        final String type = "itemInfo";
        final String direction = "internal";
        long time;
        Data data;
    }
}
