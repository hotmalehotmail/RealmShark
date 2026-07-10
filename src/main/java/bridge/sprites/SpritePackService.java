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
        // animTable: objectType -> flat frame list for animated (idle) character
        // sprites, 9 ints per frame [x,y,w,h,spriteAtlasId, mx,my,mw,mh] (mask on
        // atlas 3, all-zero when the frame has no mask). Only present for
        // objectTypes whose sprite has >1 frame.
        JsonObject animTable = new JsonObject();
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

                int[][] frames = sfb.getAnimationFrames(name, index);
                if (frames != null && frames.length > 1) {
                    JsonArray fr = new JsonArray();
                    for (int[] f : frames) for (int val : f) fr.add(val); // 9 ints/frame
                    animTable.add(String.valueOf(id), fr);
                }
            } catch (Exception e) {
                // Skip any id whose texture can't be resolved.
            }
        }
        root.add("table", table);
        root.add("maskTable", maskTable);
        root.add("animTable", animTable);

        // dyeTable: dyeId -> the cloth the dye applies, parsed from each Dye
        // object's <Tex1>/<Tex2> in the extracted XML (the dye object's sprite
        // is only a generic icon and does not carry the color). Encoding:
        //   solid  (high byte 0x01/0x02): [1, r, g, b]
        //   textile(high byte = tile size): [10, atlasId, x, y, w, h]
        JsonObject dyeTable = buildDyeTable(sfb);
        root.add("dyeTable", dyeTable);
        // animDyeTable: dyeId -> [type, speed, pivotX, pivotY] for animated cloths.
        JsonObject animDyeTable = buildAnimDyeTable(sfb);
        root.add("animDyeTable", animDyeTable);
        System.out.println("[sprite-pack] built " + v + ": table=" + table.size()
            + " maskTable=" + maskTable.size() + " dyeTable=" + dyeTable.size()
            + " animDyeTable=" + animDyeTable.size() + " animTable=" + animTable.size());

        cachedVersion = v;
        cachedPackJson = gson.toJson(root);
        return cachedPackJson;
    }

    private JsonObject cachedDyeTable;
    private JsonObject cachedAnimDyeTable;

    /** Parses an integer attribute {@code name="123"} out of an XML tag body, or {@code def}. */
    private static int intAttr(String tagBody, String name, int def) {
        java.util.regex.Matcher a = java.util.regex.Pattern
            .compile(name + "=\"(-?\\d+)\"").matcher(tagBody);
        if (!a.find()) return def;
        try {
            return Integer.parseInt(a.group(1));
        } catch (Exception e) {
            return def;
        }
    }

    /** Animated dye table built alongside {@link #buildDyeTable}; call that first. */
    private synchronized JsonObject buildAnimDyeTable(SpriteFlatBuffer sfb) {
        buildDyeTable(sfb);
        return cachedAnimDyeTable;
    }

    /**
     * Builds {@code dyeId -> cloth} by scanning the extracted object XML for
     * {@code <Class>Dye</Class>} objects and parsing their {@code <Tex1>} (or
     * {@code <Tex2>}) packed cloth value. The dye object's own sprite is only a
     * generic icon, so the color/pattern lives here, not in the atlas.
     * <p>Encoding of the packed value: high byte {@code 0x01}/{@code 0x02} =
     * solid RGB in the low 24 bits (emitted as {@code [1, r, g, b]}); otherwise
     * a textile - the high byte is the tile-size group ({@code 0x0A} ->
     * {@code textile10x10}) and the low 24 bits the in-group index; resolved to
     * its animation frames' atlas rects and emitted as
     * {@code [10, atlasId, x0,y0,w0,h0, x1,y1,w1,h1, ...]} (one 4-tuple per
     * frame; a static cloth is a single frame).
     * <p>Also builds {@link #cachedAnimDyeTable}: {@code dyeId -> [type, speed,
     * pivotX, pivotY]} from each dye's optional {@code <AnimatedDye>} element
     * (present only on animated cloths), so the renderer can scroll/rotate the
     * tiling. {@code type} selects the motion (scroll direction / rotate).
     */
    private synchronized JsonObject buildDyeTable(SpriteFlatBuffer sfb) {
        if (cachedDyeTable != null) return cachedDyeTable;
        JsonObject dyeTable = new JsonObject();
        JsonObject animDyeTable = new JsonObject();
        java.io.File xmlDir = new java.io.File("assets/xml");
        java.io.File[] files = xmlDir.listFiles((d, n) -> n.endsWith("xml"));
        if (files == null) {
            cachedDyeTable = dyeTable;
            cachedAnimDyeTable = animDyeTable;
            return dyeTable;
        }
        java.util.regex.Pattern objP = java.util.regex.Pattern.compile(
            "<Object type=\"(0x[0-9a-fA-F]+)\"[^>]*>(.*?)</Object>", java.util.regex.Pattern.DOTALL);
        java.util.regex.Pattern texP = java.util.regex.Pattern.compile(
            "<Tex[12]>(0x[0-9a-fA-F]+)</Tex[12]>");
        java.util.regex.Pattern animP = java.util.regex.Pattern.compile(
            "<AnimatedDye\\b([^>]*)/>");
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
                } else {
                    // textile: high byte = tile-size group (0x0A -> textile10x10),
                    // low 24 bits = in-group index. Resolve ALL animation frames'
                    // atlas rects so the renderer can tile and animate the cloth
                    // (the sheet is atlas 4, already shipped). Emitted as
                    // [10, atlasId, x0,y0,w0,h0, x1,y1,w1,h1, ...] - one 4-tuple
                    // per frame (a static cloth is just a single frame).
                    int size = (int) high;
                    int idx = (int) (tex & 0xFFFFFF);
                    int[][] frames = null;
                    try {
                        frames = sfb.getAnimationFrames("textile" + size + "x" + size, idx);
                    } catch (Exception ex) {
                        frames = null;
                    }
                    if (frames == null || frames.length == 0) continue; // renders undyed
                    arr.add(10);
                    arr.add(frames[0][4]); // atlasId (same across frames)
                    for (int[] fr : frames) {
                        arr.add(fr[0]); // x
                        arr.add(fr[1]); // y
                        arr.add(fr[2]); // w
                        arr.add(fr[3]); // h
                    }
                }
                dyeTable.add(String.valueOf(id), arr);

                // Optional <AnimatedDye type speed pivotX pivotY/> (animated
                // cloths only) -> [type, speed, pivotX, pivotY]. The renderer
                // uses `type` to scroll/rotate the cloth tiling at `speed`.
                java.util.regex.Matcher ad = animP.matcher(body);
                if (ad.find()) {
                    String attrs = ad.group(1);
                    JsonArray anim = new JsonArray();
                    anim.add(intAttr(attrs, "type", 0));
                    anim.add(intAttr(attrs, "speed", 0));
                    anim.add(intAttr(attrs, "pivotX", 0));
                    anim.add(intAttr(attrs, "pivotY", 0));
                    animDyeTable.add(String.valueOf(id), anim);
                }
            }
        }
        cachedDyeTable = dyeTable;
        cachedAnimDyeTable = animDyeTable;
        return dyeTable;
    }
}
