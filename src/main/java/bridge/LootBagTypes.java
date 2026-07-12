package bridge;

import assets.IdToAsset;
import com.google.gson.Gson;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Resolves which object ids are BagType 6 (white bag) / 8 (orange/ST bag)
 * loot items, and which object id is each color's own ground-bag entity,
 * from the extracted game assets (or, in {@code --fake} bridge mode, the
 * synthetic entries {@link IdToAsset#registerFake} adds) - so the overlay's
 * Loot panel can categorize picked-up items with no hand-maintained item
 * list. Broadcast as a synthetic
 * {@code {"type":"lootBagTypes","data":{"bagTypeTable":{...},"lootBagIcons":{...},"itemNames":{...}}}}
 * envelope through the normal packet-batch stream, independent of the sprite
 * pack's atlas-readiness gate ({@link bridge.sprites.SpritePackService#ready()})
 * since this data needs no atlas.
 */
public class LootBagTypes {

    /** BagType values the Loot panel tracks - see docs/asset-pipeline.md. */
    public static final int[] TRACKED_BAG_TYPES = {6, 8};

    private final Gson gson = new Gson();
    private String cachedJson;
    private int cachedObjectCount = -1;

    /** True once object assets (real or {@code --fake}-seeded) are loaded. */
    public boolean ready() {
        return IdToAsset.loadedObjectCount() > 1;
    }

    /**
     * The envelope JSON, rebuilt only when the loaded object count changes (a
     * re-extraction/reload), so repeated polling is cheap.
     */
    public synchronized String envelopeJson() {
        int count = IdToAsset.loadedObjectCount();
        if (cachedJson != null && count == cachedObjectCount) return cachedJson;

        Map<String, Integer> bagTypeTable = new LinkedHashMap<>();
        Map<String, String> itemNames = new LinkedHashMap<>();
        Map<String, Integer> lootBagObjectTypes = new LinkedHashMap<>();
        for (int id : IdToAsset.objectIds()) {
            if (id <= 0) continue;
            int bt = IdToAsset.getBagType(id);
            if (bt != 6 && bt != 8) continue;
            // The ground-bag entities themselves carry a self-identifying
            // BagType (Class=Bag). These are the *world objectTypes* the overlay
            // watches for in UpdatePacket.newObjects to read a dropped bag's
            // contents - the whole set per tracked color (regular + any boosted
            // variant sharing the BagType), unlike lootBagIcons, which is just
            // one representative icon per color. Not items a player can hold, so
            // they're kept out of bagTypeTable below.
            if ("Bag".equals(IdToAsset.getClazz(id))) {
                lootBagObjectTypes.put(String.valueOf(id), bt);
                continue;
            }
            bagTypeTable.put(String.valueOf(id), bt);
            String name = IdToAsset.objectName(id);
            if (name != null && !name.isEmpty()) itemNames.put(String.valueOf(id), name);
        }

        Map<String, Integer> lootBagIcons = new LinkedHashMap<>();
        for (int bt : TRACKED_BAG_TYPES) {
            Integer iconId = IdToAsset.findBagIconObjectType(bt);
            if (iconId != null) lootBagIcons.put(String.valueOf(bt), iconId);
        }

        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = new Data();
        env.data.bagTypeTable = bagTypeTable;
        env.data.lootBagIcons = lootBagIcons;
        env.data.lootBagObjectTypes = lootBagObjectTypes;
        env.data.itemNames = itemNames;

        cachedJson = gson.toJson(env);
        cachedObjectCount = count;
        return cachedJson;
    }

    private static final class Data {
        Map<String, Integer> bagTypeTable;
        Map<String, Integer> lootBagIcons;
        Map<String, Integer> lootBagObjectTypes;
        Map<String, String> itemNames;
    }

    /** Envelope shape matching {@link PacketSerializer}'s, so overlay clients treat it uniformly. */
    private static final class Envelope {
        final String type = "lootBagTypes";
        final String direction = "internal";
        long time;
        Data data;
    }
}
