package bridge;

import assets.IdToAsset;
import com.google.gson.Gson;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Resolves which object ids are loot items (any BagType, 0-9 - issue #217
 * widened this from the original white/orange-only scope) and which object
 * id is each color's own ground-bag entity, from the extracted game assets
 * (or, in {@code --fake} bridge mode, the synthetic entries
 * {@link IdToAsset#registerFake} adds) - so the overlay side can categorize
 * dropped items with no hand-maintained item list, for both the Loot panel
 * (white/orange only, unaffected by this widening - it constructs its
 * {@code LootTracker} with the narrow {@code [6, 8]} set) and the
 * notification system's all-color rules (PRD `docs/prd-notifications.md`
 * §2). {@code lootBagObjectTypes} (the world objectTypes the drop tracker
 * watches for) is built primarily from the real assets' id-name rule
 * ({@link IdToAsset#lootBagEntityTypes()}: {@code "Loot Bag <N>[ Boost]"},
 * N = BagType - discovered from the actual game XML in issue #189, and the
 * only mechanism that covers the boosted variants), with the legacy
 * {@code Class=Bag}+BagType scan kept for pre-facts synthetic entries even
 * though it finds nothing on real assets (soak #113/#144 - see
 * {@link IdToAsset#findBagIconObjectType}), and each of {@link #TRACKED_BAG_TYPES}'s
 * (6/8 only - the Loot panel's own category-header colors) resolved icon id
 * (or the verified known fallback) always included in {@code lootBagIcons}.
 * Broadcast as a synthetic
 * {@code {"type":"lootBagTypes","data":{"bagTypeTable":{...},"lootBagIcons":{...},"lootBagObjectTypes":{...},"itemNames":{...},"shinyItemTypes":[...],"slotTypes":{...}}}}
 * envelope through the normal packet-batch stream, independent of the sprite
 * pack's atlas-readiness gate ({@link bridge.sprites.SpritePackService#ready()})
 * since this data needs no atlas. {@code shinyItemTypes} (issue #215) is a
 * dedicated id list from {@link IdToAsset#isShiny} - NOT derivable from
 * {@code itemNames}, since {@link IdToAsset#objectName} prefers a real shiny
 * item's shared (suffix-stripped) display name whenever one is set, which on
 * real assets is true for nearly every shiny item. {@code slotTypes} (issue
 * #217) is item objectType -> {@link IdToAsset#getSlotType} for every item in
 * {@code bagTypeTable} - the equipment-category enum the notification
 * system's per-category enchant-threshold overrides key off.
 */
public class LootBagTypes {

    /**
     * BagType values the Loot panel's own category-header icons cover - see
     * docs/asset-pipeline.md. NOT a filter on {@code bagTypeTable}/
     * {@code itemNames}/{@code lootBagObjectTypes}/{@code slotTypes} below,
     * which cover every BagType present in the loaded assets (issue #217) -
     * only {@code lootBagIcons} stays scoped to these two colors.
     */
    public static final int[] TRACKED_BAG_TYPES = {6, 8};

    private final Gson gson = new Gson();
    private String cachedJson;
    private int cachedObjectCount = -1;

    /** True once object assets (real or {@code --fake}-seeded) are loaded. */
    public boolean ready() {
        return IdToAsset.loadedObjectCount() > 1;
    }

    /**
     * Content-version key for the edge-triggered delivery contract (issue
     * #239): the table is rebuilt exactly when the loaded object count
     * changes ({@link #envelopeJson}'s cache key), so the count IS the
     * version. Cheap enough for {@code PacketBridge}'s poll to compare every
     * tick without building any JSON; also stamped into the envelope as
     * {@code data.metaVersion} so clients can skip re-applying a table they
     * already hold (a WS reconnect legitimately redelivers it).
     */
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

        Map<String, Integer> bagTypeTable = new LinkedHashMap<>();
        Map<String, String> itemNames = new LinkedHashMap<>();
        List<Integer> shinyItemTypes = new ArrayList<>();
        Map<String, Integer> lootBagObjectTypes = new LinkedHashMap<>();
        Map<String, Integer> slotTypes = new LinkedHashMap<>();
        for (int id : IdToAsset.objectIds()) {
            if (id <= 0) continue;
            int bt = IdToAsset.getBagType(id);
            // Every BagType present in the loaded assets is covered (issue
            // #217) - not just 6/8. -1 means "no BagType at all" (not a loot
            // item/bag entity), the only value excluded here.
            if (bt < 0) continue;
            // The ground-bag entities themselves carry a self-identifying
            // BagType (Class=Bag). These are the *world objectTypes* the overlay
            // watches for in UpdatePacket.newObjects to read a dropped bag's
            // contents - the whole set per color (regular + any boosted
            // variant sharing the BagType), unlike lootBagIcons, which is just
            // one representative icon per tracked (6/8) color. Not items a
            // player can hold, so they're kept out of bagTypeTable below.
            if ("Bag".equals(IdToAsset.getClazz(id))) {
                lootBagObjectTypes.put(String.valueOf(id), bt);
                continue;
            }
            bagTypeTable.put(String.valueOf(id), bt);
            String name = IdToAsset.objectName(id);
            if (name != null && !name.isEmpty()) itemNames.put(String.valueOf(id), name);
            if (IdToAsset.isShiny(id)) shinyItemTypes.add(id);
            slotTypes.put(String.valueOf(id), IdToAsset.getSlotType(id));
        }

        // The real assets' discovery rule (issue #189): ground-bag entities are
        // identified by id name ("Loot Bag <N>[ Boost]", N = the BagType) -
        // Class=Container, no self-reported BagType, so the Class=Bag scan
        // above can never find them. This is what recognizes every color's
        // BOOSTED variant, which the fallback below (one icon id per tracked
        // color) never covered - before this rule a boosted bag drop was
        // invisible to the overlay's drop tracker. Every color, not just 6/8
        // (issue #217) - lootBagObjectTypes is the drop-detection set, unlike
        // lootBagIcons below which stays scoped to the Loot panel's colors.
        IdToAsset.lootBagEntityTypes().forEach((id, bt) ->
            lootBagObjectTypes.putIfAbsent(String.valueOf(id), bt));

        Map<String, Integer> lootBagIcons = new LinkedHashMap<>();
        for (int bt : TRACKED_BAG_TYPES) {
            Integer iconId = IdToAsset.findBagIconObjectType(bt);
            if (iconId != null) {
                lootBagIcons.put(String.valueOf(bt), iconId);
                // Soak #113 found the ground-bag entity's own Object XML entry
                // doesn't reliably carry a matching Class=Bag+BagType pair on
                // real assets, so the scan the loop above relies on can come up
                // empty for a tracked color - the same gap findBagIconObjectType
                // already works around (real scan match, else a known fallback
                // id). Without this, lootBagObjectTypes stayed empty on real
                // assets and the overlay's drop tracker never recognized a bag
                // entity at all (soak #144) - reuse the same resolved id here so
                // the tracker is told to watch for it regardless of how it was
                // resolved.
                lootBagObjectTypes.putIfAbsent(String.valueOf(iconId), bt);
            }
        }

        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = new Data();
        env.data.metaVersion = "oc" + count;
        env.data.bagTypeTable = bagTypeTable;
        env.data.lootBagIcons = lootBagIcons;
        env.data.lootBagObjectTypes = lootBagObjectTypes;
        env.data.itemNames = itemNames;
        env.data.shinyItemTypes = shinyItemTypes;
        env.data.slotTypes = slotTypes;

        cachedJson = gson.toJson(env);
        cachedObjectCount = count;
        return cachedJson;
    }

    private static final class Data {
        String metaVersion;
        Map<String, Integer> bagTypeTable;
        Map<String, Integer> lootBagIcons;
        Map<String, Integer> lootBagObjectTypes;
        Map<String, String> itemNames;
        List<Integer> shinyItemTypes;
        Map<String, Integer> slotTypes;
    }

    /** Envelope shape matching {@link PacketSerializer}'s, so overlay clients treat it uniformly. */
    private static final class Envelope {
        final String type = "lootBagTypes";
        final String direction = "internal";
        long time;
        Data data;
    }
}
