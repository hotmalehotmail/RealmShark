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

    /** Human-readable readiness state, for diagnosing why sprites aren't showing. */
    public synchronized String diagnostic() {
        return "objects=" + IdToAsset.loadedObjectCount()
            + " charactersPng=" + new File(ATLASES[1]).exists();
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
        // maskTable: objectType -> [maskAtlasId(=3), x, y, w, h] for sprites that
        // have a dye mask (marks clothing/accessory regions) - used for dye
        // compositing. Only present for objectTypes that carry a mask.
        SpriteFlatBuffer sfb = new SpriteFlatBuffer();
        JsonObject table = new JsonObject();
        JsonObject maskTable = new JsonObject();
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

                int[] m = sfb.getMaskSpriteData(name, index); // {x, y, w, h} or null
                if (m != null) {
                    JsonArray mrect = new JsonArray();
                    mrect.add(3); // characters_masks atlas
                    mrect.add(m[0]);
                    mrect.add(m[1]);
                    mrect.add(m[2]);
                    mrect.add(m[3]);
                    maskTable.add(String.valueOf(id), mrect);
                }
            } catch (Exception e) {
                // Skip any id whose texture can't be resolved.
            }
        }
        root.add("table", table);
        root.add("maskTable", maskTable);

        // dyeTable: dyeId -> the cloth the dye applies, parsed from each Dye
        // object's <Tex1>/<Tex2> in the extracted XML (the dye object's sprite
        // is only a generic icon and does not carry the color). Encoding:
        //   solid  (high byte 0x01): [1, r, g, b]
        //   textile(high nibble 0xA): [10, textileIndex]
        JsonObject dyeTable = buildDyeTable();
        root.add("dyeTable", dyeTable);
        System.out.println("[sprite-pack] built " + v + ": table=" + table.size()
            + " maskTable=" + maskTable.size() + " dyeTable=" + dyeTable.size());

        // TEMP [dye-diag] Where do character dye masks actually live? Dump the
        // set of sprite groups that carry any mask, plus the per-index mask map
        // for the player class the user is on (804) and its base texture slot.
        try {
            System.out.println("[dye-diag] " + sfb.describeAllMaskGroups());
            for (int classId : new int[]{804, 782, 768}) {
                String cn = IdToAsset.getObjectTextureName(classId, 0);
                int ci = (cn == null) ? -1 : IdToAsset.getObjectTextureIndex(classId, 0);
                System.out.println("[dye-diag] class " + classId + " tex=" + cn + " index=" + ci
                    + " | " + (cn == null ? "<no texture>" : sfb.describeGroupMasks(cn)));
            }
        } catch (Exception e) {
            System.out.println("[dye-diag] failed: " + e);
        }

        // TEMP [dye-groups] All sprite groups + sizes, to locate the sheet that
        // holds textile patterns (textile Tex1 = 0x0A......, e.g. index 25).
        try {
            System.out.println("[dye-groups] " + sfb.describeAllGroups());
        } catch (Exception e) {
            System.out.println("[dye-groups] failed: " + e);
        }

        // TEMP [dye-xml] Dump the raw <Object> XML for a solid clothing dye, a
        // solid accessory dye, and a textile, to confirm the Tex1 encoding for
        // each. Reads the extracted assets/xml/*.xml on disk.
        try {
            // Deep Pink Clothing Dye, Alice Blue Accessory Dye, Large Lemon-Lime Cloth
            String[] types = {"0x1026", "0x1100", "0x122f"};
            java.io.File xmlDir = new java.io.File("assets/xml");
            java.io.File[] files = xmlDir.listFiles((d, n) -> n.endsWith("xml"));
            if (files == null) {
                System.out.println("[dye-xml] no assets/xml dir at " + xmlDir.getAbsolutePath());
            } else {
                for (String type : types) {
                    String found = null;
                    for (java.io.File f : files) {
                        String txt = new String(Files.readAllBytes(f.toPath()));
                        int i = txt.indexOf("type=\"" + type + "\"");
                        if (i < 0) continue;
                        int start = txt.lastIndexOf("<Object", i);
                        int end = txt.indexOf("</Object>", i);
                        if (start >= 0 && end >= 0) {
                            found = txt.substring(start, end + 9).replaceAll("\\s+", " ");
                            break;
                        }
                    }
                    System.out.println("[dye-xml] " + type + " => "
                        + (found == null ? "<not found>" : found));
                }
            }
        } catch (Exception e) {
            System.out.println("[dye-xml] failed: " + e);
        }

        cachedVersion = v;
        cachedPackJson = gson.toJson(root);
        return cachedPackJson;
    }

    private JsonObject cachedDyeTable;

    /**
     * Builds {@code dyeId -> cloth} by scanning the extracted object XML for
     * {@code <Class>Dye</Class>} objects and parsing their {@code <Tex1>} (or
     * {@code <Tex2>}) packed cloth value. The dye object's own sprite is only a
     * generic icon, so the color/pattern lives here, not in the atlas.
     * <p>Encoding of the packed value: high byte {@code 0x01} = solid RGB in the
     * low 24 bits (emitted as {@code [1, r, g, b]}); high nibble {@code 0xA} =
     * textile, low 24 bits are the textile index (emitted as {@code [10, idx]}).
     */
    private synchronized JsonObject buildDyeTable() {
        if (cachedDyeTable != null) return cachedDyeTable;
        JsonObject dyeTable = new JsonObject();
        java.io.File xmlDir = new java.io.File("assets/xml");
        java.io.File[] files = xmlDir.listFiles((d, n) -> n.endsWith("xml"));
        if (files == null) {
            cachedDyeTable = dyeTable;
            return dyeTable;
        }
        java.util.regex.Pattern objP = java.util.regex.Pattern.compile(
            "<Object type=\"(0x[0-9a-fA-F]+)\"[^>]*>(.*?)</Object>", java.util.regex.Pattern.DOTALL);
        java.util.regex.Pattern texP = java.util.regex.Pattern.compile(
            "<Tex[12]>(0x[0-9a-fA-F]+)</Tex[12]>");
        for (java.io.File f : files) {
            String txt;
            try {
                txt = new String(Files.readAllBytes(f.toPath()));
            } catch (Exception e) {
                continue;
            }
            if (!txt.contains("<Class>Dye</Class>")) continue;
            java.util.regex.Matcher m = objP.matcher(txt);
            while (m.find()) {
                String body = m.group(2);
                if (!body.contains("<Class>Dye</Class>")) continue;
                java.util.regex.Matcher t = texP.matcher(body);
                if (!t.find()) continue;
                long tex;
                int id;
                try {
                    tex = Long.decode(t.group(1));
                    id = Integer.decode(m.group(1));
                } catch (Exception e) {
                    continue;
                }
                long high = (tex >> 24) & 0xFF;
                JsonArray arr = new JsonArray();
                if (high == 0x01 || high == 0x02) { // solid RGB
                    arr.add(1);
                    arr.add((int) ((tex >> 16) & 0xFF));
                    arr.add((int) ((tex >> 8) & 0xFF));
                    arr.add((int) (tex & 0xFF));
                } else { // textile: low 24 bits are the pattern index
                    arr.add(10);
                    arr.add((int) (tex & 0xFFFFFF));
                }
                dyeTable.add(String.valueOf(id), arr);
            }
        }
        cachedDyeTable = dyeTable;
        return dyeTable;
    }
}
