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
 * Unlike {@link ItemInfo}/{@link LootBagTypes}, this table has no async
 * loading step to poll for: {@link ParseEnchants}'s static initializer reads
 * the XML file synchronously the first time the class is referenced, so by
 * the time this class is constructed the map (real names, or just its
 * built-in {@code -1 -> "[empty]"} entry if the XML is missing) is already
 * final for the process's lifetime.
 */
public class EnchantNames {

    private final Gson gson = new Gson();
    private String cachedJson;

    /** Envelope JSON, built once and cached - {@link ParseEnchants#ENCHANTS} never changes after class init. */
    public synchronized String envelopeJson() {
        if (cachedJson != null) return cachedJson;

        Map<String, String> names = new LinkedHashMap<>();
        for (Map.Entry<Short, String> e : ParseEnchants.ENCHANTS.entrySet()) {
            names.put(String.valueOf(e.getKey()), e.getValue());
        }

        Envelope env = new Envelope();
        env.time = System.currentTimeMillis();
        env.data = new Data();
        env.data.names = names;

        cachedJson = gson.toJson(env);
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
