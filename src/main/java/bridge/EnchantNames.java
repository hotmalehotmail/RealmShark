package bridge;

import bridge.dps.ParseEnchants;
import com.google.gson.Gson;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Resolves enchantment id -&gt; display name, from {@link ParseEnchants#ENCHANTS}
 * (loaded once from {@code assets/xml/enchantments.xml} - a machine with the
 * game). Broadcast the same way as {@link LootBagTypes}/{@link ItemInfo}: a
 * tiny, periodically re-sent
 * {@code {"type":"enchantNames","data":{"names":{"&lt;id&gt;":"&lt;name&gt;",...}}}}
 * envelope, so the overlay's item tooltip (issue #109) can show real
 * enchantment names for an equipped item's decoded {@code UNIQUE_DATA_STRING}
 * slots ({@link ParseEnchants#extractEnchantIds}) when available, and fall
 * back to the bare enchant id when it isn't (headless {@code --fake} mode, or
 * any machine without the game's XML assets extracted).
 * <p>
 * Like {@link ItemInfo}/{@link LootBagTypes}, the underlying table can start
 * out empty: {@link ParseEnchants}'s static initializer reads the XML file
 * synchronously the first time the class is referenced (which can be this
 * class's own first broadcast, 2s after bridge startup - well before the
 * background asset extraction {@code ObjectNames.init} kicks off finishes on
 * a real machine), and only {@link ParseEnchants#reload} (called once
 * extraction completes) picks up the real data afterward. {@link
 * #envelopeJson} tracks {@link ParseEnchants#ENCHANTS}' size the same way
 * those two track {@code IdToAsset.loadedObjectCount()}, so a reload is
 * reflected on the next poll instead of being cached away forever.
 */
public class EnchantNames {

    private final Gson gson = new Gson();
    private String cachedJson;
    private int cachedEnchantCount = -1;

    /**
     * Envelope JSON, rebuilt only when {@link ParseEnchants#ENCHANTS}' size
     * changes (a background asset-extraction reload via {@link
     * ParseEnchants#reload}), so repeated polling is cheap. Must NOT cache
     * unconditionally after the first call - {@code ENCHANTS} can still be its
     * pre-extraction, near-empty state (just the built-in {@code -1} entry)
     * the first time this runs, since extraction happens on a background
     * thread this class has no ordering guarantee against.
     */
    public synchronized String envelopeJson() {
        int count = ParseEnchants.ENCHANTS.size();
        if (cachedJson != null && count == cachedEnchantCount) return cachedJson;

        Map<String, String> names = new LinkedHashMap<>();
        for (Map.Entry<Short, String> e : ParseEnchants.ENCHANTS.entrySet()) {
            names.put(String.valueOf(e.getKey()), e.getValue());
        }

        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = new Data();
        env.data.names = names;

        cachedJson = gson.toJson(env);
        cachedEnchantCount = count;
        return cachedJson;
    }

    private static final class Data {
        Map<String, String> names;
    }

    /** Envelope shape matching {@link PacketSerializer}'s, so overlay clients treat it uniformly. */
    private static final class Envelope {
        final String type = "enchantNames";
        final String direction = "internal";
        long time;
        Data data;
    }
}
