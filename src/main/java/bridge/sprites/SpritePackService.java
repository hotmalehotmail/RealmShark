package bridge.sprites;

import assets.IdToAsset;
import assets.SpriteFlatBuffer;
import com.google.gson.Gson;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;

import java.io.File;
import java.nio.file.Files;
import java.util.Base64;

/**
 * Builds the self-contained "sprite pack" the overlay uses to render sprites
 * client-side: the four RotMG sprite-atlas PNGs plus a flat
 * {@code objectType -> [atlasId, x, y, w, h]} coordinate table. The overlay
 * crops any sprite locally from that, so it only needs the pack once per game
 * version - after which there is no per-sprite traffic.
 * <p>
 * The pack is derived from the same extracted assets {@link ObjectNames}
 * already loads ({@link IdToAsset} + the flatbuffer spritesheet); this class
 * never triggers extraction itself. When assets aren't available (no game
 * installed / not yet extracted) it reports not-ready and the overlay falls
 * back to placeholder chips.
 */
public class SpritePackService {

    // Index i (0-based) here corresponds to atlasId i+1 in the flatbuffer data,
    // matching assets.ImageBuffer's spriteSheets order.
    private static final String[] ATLASES = {
        "assets/sprites/groundTiles.png",
        "assets/sprites/characters.png",
        "assets/sprites/characters_masks.png",
        "assets/sprites/mapObjects.png"
    };

    private final Gson gson = new Gson();
    private String cachedVersion;
    private String cachedPackJson;

    /** True once real object assets are loaded and the character atlas exists on disk. */
    public synchronized boolean ready() {
        return IdToAsset.loadedObjectCount() > 1 && new File(ATLASES[1]).exists();
    }

    /**
     * Version key for the current pack - changes whenever the atlas is
     * re-extracted (a game update), so the overlay knows to refetch.
     *
     * @return version string, or null when assets aren't ready.
     */
    public synchronized String version() {
        if (!ready()) return null;
        return "v" + new File(ATLASES[1]).lastModified();
    }

    /**
     * Builds the response to a {@code spritePackRequest}. If the client already
     * holds the current version, a tiny up-to-date ack is returned instead of
     * the (multi-MB) payload; if assets aren't ready, a not-ready frame.
     *
     * @param haveVersion the version the client already has cached, or null.
     * @return a JSON {@code spritePack} message to send back to that client.
     */
    public synchronized String responseFor(String haveVersion) {
        String v = version();
        if (v == null) {
            return "{\"type\":\"spritePack\",\"ready\":false}";
        }
        if (v.equals(haveVersion)) {
            return "{\"type\":\"spritePack\",\"ready\":true,\"upToDate\":true,\"version\":\""
                + v + "\"}";
        }
        return buildPack(v);
    }

    private String buildPack(String v) {
        if (cachedPackJson != null && v.equals(cachedVersion)) return cachedPackJson;

        JsonObject root = new JsonObject();
        root.addProperty("type", "spritePack");
        root.addProperty("ready", true);
        root.addProperty("version", v);

        // atlases: atlasId (1-4) -> data URL of the PNG.
        JsonObject atlases = new JsonObject();
        for (int i = 0; i < ATLASES.length; i++) {
            File f = new File(ATLASES[i]);
            if (!f.exists()) continue;
            try {
                byte[] bytes = Files.readAllBytes(f.toPath());
                atlases.addProperty(String.valueOf(i + 1),
                    "data:image/png;base64," + Base64.getEncoder().encodeToString(bytes));
            } catch (Exception e) {
                // Skip an unreadable atlas; the overlay just can't render its sprites.
            }
        }
        root.add("atlases", atlases);

        // table: objectType -> [atlasId, x, y, w, h], resolved via the same
        // IdToAsset -> flatbuffer path assets.ImageBuffer.getImage uses.
        SpriteFlatBuffer sfb = new SpriteFlatBuffer();
        JsonObject table = new JsonObject();
        for (int id : IdToAsset.objectIds()) {
            if (id <= 0) continue;
            try {
                String name = IdToAsset.getObjectTextureName(id, 0);
                if (name == null) continue;
                int index = IdToAsset.getObjectTextureIndex(id, 0);
                int[] d = sfb.getSpriteData(name, index); // {x, y, w, h, aId}
                if (d == null) continue;
                JsonArray rect = new JsonArray();
                rect.add(d[4]); // atlasId
                rect.add(d[0]);
                rect.add(d[1]);
                rect.add(d[2]);
                rect.add(d[3]);
                table.add(String.valueOf(id), rect);
            } catch (Exception e) {
                // Skip any id whose texture can't be resolved.
            }
        }
        root.add("table", table);

        cachedVersion = v;
        cachedPackJson = gson.toJson(root);
        return cachedPackJson;
    }
}
