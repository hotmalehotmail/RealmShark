package assets;

import java.io.BufferedReader;
import java.io.File;
import java.io.InputStreamReader;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;

/**
 * Id to asset class. Used to convert incoming realm IDs to the corresponding asset.
 */
public class IdToAsset {
    /**
     * Suffix marking a "shiny" item variant on its raw XML {@code id} (issue
     * #193/#215) - e.g. {@code "Dirk of Cronus Shiny"}. Checked against
     * {@link #idName}, NOT {@link #display}/{@link #objectName}: a shiny
     * item's {@code <DisplayId>} is the shared base name with the suffix
     * stripped (real assets, confirmed on soak #215's alpha - the same shared
     * name a non-shiny variant of the same item also carries), so deriving
     * shininess from the resolved display name silently loses the signal for
     * every real shiny item that has a display name at all.
     */
    private static final String SHINY_SUFFIX = " Shiny";
    private final String l;
    private final int id;
    private final String idName;
    private final String display;
    private final String clazz;
    private final String group;
    private final String label;
    private int tileDmg;
    private Projectile[] projectiles = null;
    private final String texture;
    private Texture[] textures = null;
    /** Whether {@link #idName} carries the {@link #SHINY_SUFFIX}. Computed once at construction. */
    private final boolean shiny;
    /**
     * Parsed {@code <BagType>} value (a 0-9 enum; 6 = white bag, 8 = orange/ST
     * bag - see docs/asset-pipeline.md), or -1 when the object carries none.
     * On an item, this is which color bag it drops in; on a Bag-class object
     * (the ground bag entity itself), this is which color bag it is.
     */
    private final int bagType;
    /** Raw {@code <Tier>} value (e.g. "UT", "1".."15"), or "" if none. */
    private final String tier;
    /** Raw, semicolon/newline-sanitized {@code <Description>} value, or "" if none. */
    private final String description;
    /**
     * Parsed {@code <SlotType>} value - the item's equipment-category enum
     * (issue #217; e.g. objectType 283 "The Hive Key" -> 10), 0 when the
     * object carries none - matching {@code AssetFacts.Item#slotType}'s same
     * default, since 0 is indistinguishable from "unset" in both. NOT the
     * same thing as {@link #getIdProjectileSlotType}, which reads the same
     * XML tag but only for a weapon's projectile-group data.
     */
    private final int slotType;
    private static final HashMap<Integer, IdToAsset> objectID = new HashMap<>();
    private static final HashMap<Integer, IdToAsset> tileID = new HashMap<>();
    /**
     * Entries registered via {@link #registerFake} (the {@code --fake} bridge
     * mode, no game installed) - kept separately and re-applied after every
     * {@link #reloadAssets()} so a background asset (re)load can never race
     * away a synthetic entry regardless of call order.
     */
    private static final HashMap<Integer, IdToAsset> fakeEntries = new HashMap<>();

    /**
     * Constructor for the object resources.
     *
     * @param l           Base string before parsing
     * @param id          Id of the resource
     * @param idName      Name of the resource
     * @param display     Display name of the resource
     * @param clazz       Class of the resource
     * @param projectiles Projectile min,max,armorPiercin
     * @param texture     Texture name and index used to f
     * @param label       Label of the resource
     * @param group       Group of the resource
     * @param bagType     Raw {@code <BagType>} value, or "" if none
     * @param tier        Raw {@code <Tier>} value, or "" if none
     * @param description Sanitized {@code <Description>} value, or "" if none
     * @param slotType    Raw {@code <SlotType>} value, or "" if none
     */
    public IdToAsset(String l, int id, String idName, String display, String clazz, Projectile[] projectiles, String texture, String label, String group, String bagType, String tier, String description, String slotType) {
        this.l = l;
        this.id = id;
        this.idName = idName;
        this.display = display;
        this.clazz = clazz;
        this.projectiles = projectiles;
        this.texture = texture;
        this.label = label;
        this.group = group;
        this.bagType = parseBagType(bagType);
        this.tier = tier == null ? "" : tier;
        this.description = description == null ? "" : description;
        this.slotType = parseIntField(slotType, 0);
        this.shiny = idName != null && idName.endsWith(SHINY_SUFFIX);
    }

    /**
     * Constructor for the tile resources.
     *
     * @param l       Base string before parsing
     * @param id      Id of the resource
     * @param damage  Tile damage
     * @param idName  Name of the resource
     * @param texture Texture name and index used to find the image
     */
    public IdToAsset(String l, int id, int damage, String idName, String texture) {
        this.l = l;
        this.id = id;
        this.tileDmg = damage;
        this.idName = idName;
        this.texture = texture;

        display = "";
        clazz = "";
        group = "";
        label = "";
        bagType = -1;
        tier = "";
        description = "";
        slotType = 0;
        shiny = idName != null && idName.endsWith(SHINY_SUFFIX);
    }

    /*
     * Construct the list on start of using this class.
     */
    static {
        readObjectList();
        readTileList();
    }

    /**
     * Reloads assets from files. Synthetic entries registered via
     * {@link #registerFake} are re-applied afterward, so they survive a
     * reload regardless of whether it ran before or after registration.
     */
    public static void reloadAssets() {
        objectID.clear();
        tileID.clear();
        readObjectList();
        readTileList();
        objectID.putAll(fakeEntries);
    }

    /**
     * Registers a synthetic object entry directly, bypassing ObjectID.list -
     * used only by the {@code --fake} bridge mode to demonstrate asset-derived
     * features (e.g. loot-bag categorization) with no game installed. Never
     * used by the real extraction path.
     *
     * @param id      Synthetic object id (must not collide with a real one).
     * @param clazz   Class of the fake object (e.g. "Bag" for a ground-bag entity).
     * @param bagType BagType to report for this id.
     */
    public static void registerFake(int id, String clazz, int bagType) {
        registerFake(id, clazz, bagType, "", "", "");
    }

    /**
     * Drops every {@link #registerFake}/{@link #registerFakeNamed} entry and
     * reloads the base assets. Registered fakes are otherwise process-wide and
     * permanent, which made shared-JVM tests order-dependent - call this in a
     * test's setup for a hermetic start. Not used by the bridge at runtime.
     */
    public static void clearFakeEntries() {
        fakeEntries.clear();
        reloadAssets();
    }

    /**
     * Like {@link #registerFake(int, String, int)} but with an explicit id
     * name, for facts-seeded entries (issue #189) that must carry the REAL
     * asset name - e.g. the ground-bag entities, whose BagType the live
     * assets encode only in the id string ({@code "Loot Bag <N>[ Boost]"},
     * see {@link #lootBagEntityTypes()}), so a fake entry named
     * {@code Fake<id>} could never exercise that rule.
     */
    public static void registerFakeNamed(int id, String idName, String clazz, int bagType) {
        IdToAsset entry = new IdToAsset(
            "", id, idName == null || idName.isEmpty() ? "Fake" + id : idName,
            "", clazz, null, "", "", "", String.valueOf(bagType), "", "", ""
        );
        fakeEntries.put(id, entry);
        objectID.put(id, entry);
    }

    /**
     * Like {@link #registerFake(int, String, int)}, additionally seeding the
     * item-info fields (issue #109) so the {@code --fake} bridge mode can
     * demonstrate the item tooltip end-to-end with no game installed.
     *
     * @param id          Synthetic object id (must not collide with a real one).
     * @param clazz       Class of the fake object (e.g. "Equipment").
     * @param bagType     BagType to report for this id.
     * @param tier        Fake {@code <Tier>} value, or "" for none.
     * @param display     Fake display name, or "" to fall back to "Fake&lt;id&gt;".
     * @param description Fake description, or "" for none.
     */
    public static void registerFake(
        int id, String clazz, int bagType, String tier, String display, String description
    ) {
        registerFake(id, clazz, bagType, tier, "Fake" + id, display, description);
    }

    /**
     * Like {@link #registerFake(int, String, int, String, String, String)},
     * additionally taking an explicit raw {@code idName} instead of the
     * hardcoded {@code "Fake<id>"} - needed to simulate a real shiny item in
     * {@code --fake} mode (issue #215), since {@link #isShiny} checks the raw
     * id, not {@code display}.
     *
     * @param id          Synthetic object id (must not collide with a real one).
     * @param clazz       Class of the fake object (e.g. "Equipment").
     * @param bagType     BagType to report for this id.
     * @param tier        Fake {@code <Tier>} value, or "" for none.
     * @param idName      Fake raw id name, or "" to fall back to "Fake&lt;id&gt;".
     * @param display     Fake display name, or "" to fall back to "Fake&lt;id&gt;".
     * @param description Fake description, or "" for none.
     */
    public static void registerFake(
        int id, String clazz, int bagType, String tier, String idName, String display, String description
    ) {
        registerFake(id, clazz, bagType, 0, tier, idName, display, description);
    }

    /**
     * Like {@link #registerFake(int, String, int, String, String, String, String)},
     * additionally taking an explicit {@code slotType} (issue #217's item
     * equipment-category enum) - needed for a facts-seeded item to carry its
     * real {@code SlotType} in {@code --fake} mode, e.g.
     * {@link bridge.FakePacketSource#registerFactsItem}.
     *
     * @param slotType SlotType to report for this id (see {@link #getSlotType}), 0 for none.
     */
    public static void registerFake(
        int id, String clazz, int bagType, int slotType, String tier, String idName, String display, String description
    ) {
        IdToAsset entry = new IdToAsset(
            "", id, idName == null || idName.isEmpty() ? "Fake" + id : idName,
            display == null ? "" : display, clazz, null, "", "", "",
            String.valueOf(bagType), tier == null ? "" : tier, description == null ? "" : description,
            String.valueOf(slotType)
        );
        fakeEntries.put(id, entry);
        objectID.put(id, entry);
    }

    /** Parses a raw {@code <BagType>} string (decimal or 0x-hex) to an int, or -1 if blank/unparseable. */
    private static int parseBagType(String raw) {
        return parseIntField(raw, -1);
    }

    /** Parses a raw decimal-or-0x-hex XML value to an int, or {@code fallback} if blank/unparseable. */
    private static int parseIntField(String raw, int fallback) {
        if (raw == null || raw.isEmpty()) return fallback;
        try {
            return raw.startsWith("0x") ? Integer.decode(raw) : Integer.parseInt(raw.trim());
        } catch (Exception e) {
            return fallback;
        }
    }

    /**
     * Method to grab the full list of object resource's from file and construct the hashmap.
     */
    private static void readObjectList() {
        File objectsFile = new File(AssetExtractor.ASSETS_OBJECT_FILE_DIR_PATH);
        if (!objectsFile.exists()) return;
        String lineCheck = "";
        try {
            BufferedReader br = new BufferedReader(new InputStreamReader(Files.newInputStream(objectsFile.toPath())));
            String line;

            while ((line = br.readLine()) != null) {
                String[] l = line.split(";");
                lineCheck = line;
                int id = Integer.parseInt(l[0]);
                String display = l[1];
                String clazz = l[2];
                String group = l[3];
                String projectile = l[4];
                Projectile[] projectiles = parseProjectile(projectile);
                String texture = l[5];
                String label = l[6];
                String idName = l[7];
                // bagType/tier/description/slotType are newer columns - default
                // "" for an older ObjectID.list written before they existed.
                String bagType = l.length > 8 ? l[8] : "";
                String tier = l.length > 9 ? l[9] : "";
                String description = l.length > 10 ? l[10] : "";
                String slotType = l.length > 11 ? l[11] : "";
                objectID.put(id, new IdToAsset(line, id, idName, display, clazz, projectiles, texture, label, group, bagType, tier, description, slotType));
            }
            br.close();
        } catch (Exception e) {
            System.out.println(lineCheck);
            e.printStackTrace();
        }

        objectID.put(-1, new IdToAsset("", -1, "Unloaded", "Unloaded", "", null, "", "", "Unloaded", "", "", "", ""));
    }

    /**
     * Method to grab the full list of tile resource's from file and construct the hashmap.
     */
    private static void readTileList() {
        File tilesFile = new File(AssetExtractor.ASSETS_TILE_FILE_DIR_PATH);
        if (!tilesFile.exists()) return;
        try {
            BufferedReader br = new BufferedReader(new InputStreamReader(Files.newInputStream(tilesFile.toPath())));
            String line;

            while ((line = br.readLine()) != null) {
                String[] l = line.split(";");
                int id = Integer.parseInt(l[0]);
                String texture = l[1];
                String dmg = l[2];
                int damage = 0;
                if (!dmg.isEmpty()) {
                    String[] s = dmg.split(",");
                    if (s[0].equals(s[1])) {
                        damage = Integer.parseInt(s[0]);
                    } else {
                        System.out.println("Nonuniform tile damage");
                    }
                }
                String idName = l[3];
                tileID.put(id, new IdToAsset(line, id, damage, idName, texture));
            }
            br.close();
        } catch (Exception e) {
            e.printStackTrace();
        }

        tileID.put(-1, new IdToAsset("", -1, -1, "Unknown", ""));
    }

    public static void main(String[] args) {

    }

    /**
     * Method to grab the name of the object resource.
     * If display name is not present, use the regular name.
     *
     * @param id Id of the object.
     * @return Best descriptive name of the resource
     */
    public static String objectName(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        if (i.display.equals("")) return i.idName;
        return i.display;
    }

    /**
     * Whether an object id is a "shiny" item variant (issue #193/#215) - the
     * raw XML id carries the {@link #SHINY_SUFFIX}, independent of whatever
     * {@link #objectName} resolves to. See {@code bridge/LootBagTypes.java}'s
     * {@code shinyItemTypes}, the wire signal that replaced deriving this from
     * the (frequently suffix-stripped) resolved display name.
     *
     * @param id Id of the object.
     * @return true if this id is a shiny variant, false if not or unknown.
     */
    public static boolean isShiny(int id) {
        IdToAsset i = objectID.get(id);
        return i != null && i.shiny;
    }

    /**
     * Number of object entries currently loaded - lets a headless caller (e.g.
     * the bridge) confirm assets actually loaded, since a missing asset file
     * leaves the map effectively empty rather than throwing.
     *
     * @return count of loaded object entries.
     */
    public static int loadedObjectCount() {
        return objectID.size();
    }

    /**
     * All loaded object type ids. Lets a caller (e.g. the sprite-pack builder)
     * enumerate every object without exposing the backing map.
     *
     * @return a copy of the loaded object type ids.
     */
    public static java.util.Set<Integer> objectIds() {
        return new java.util.HashSet<>(objectID.keySet());
    }

    /**
     * Method to grab the name of the tile resource.
     * If display name is not present, use the regular name.
     *
     * @param id Id of the tile.
     * @return Best descriptive name of the resource
     */
    public static String tileName(int id) {
        IdToAsset i = tileID.get(id);
        if (i == null) return null;
        return i.idName;
    }

    /**
     * Common name of the object.
     *
     * @param id Id of the object.
     * @return Regular name of the object.
     */
    public static String getObjectIdName(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        return i.idName;
    }

    /**
     * Display name of the object.
     *
     * @param id Id of the object.
     * @return Display name of the object.
     */
    public static String getDisplayName(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        return i.display;
    }

    /**
     * Class of the object.
     *
     * @param id Id of the object.
     * @return Class name of the object.
     */
    public static String getClazz(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        return i.clazz;
    }

    /**
     * Group of the object.
     *
     * @param id Id of the object.
     * @return Group name of the object.
     */
    public static String getIdGroup(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        return i.group;
    }

    /**
     * Label of the object.
     *
     * @param id Id of the object.
     * @return Label of the object.
     */
    public static String getIdLabel(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        return i.label;
    }

    /**
     * BagType of the object (a 0-9 enum; 6 = white bag, 8 = orange/ST bag -
     * see docs/asset-pipeline.md). On an item this is which color bag it
     * drops in; on a Bag-class object this is which color bag entity it is.
     *
     * @param id Id of the object.
     * @return BagType, or -1 if unknown/not set.
     */
    public static int getBagType(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return -1;
        return i.bagType;
    }

    /**
     * SlotType of the object (issue #217) - the item's equipment-category
     * enum from its {@code <SlotType>} tag (e.g. objectType 283 "The Hive
     * Key" -&gt; 10; see {@code AssetFacts.Item#slotType} for the ground
     * truth). NOT the same as {@link #getIdProjectileSlotType}, which reads
     * the same XML tag but only for a weapon's projectile-group data.
     *
     * @param id Id of the object.
     * @return SlotType, or 0 if unknown/not set (indistinguishable from an
     *     object whose real SlotType is 0 - matches {@code AssetFacts.Item}'s
     *     same default).
     */
    public static int getSlotType(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return 0;
        return i.slotType;
    }

    /**
     * Tier of the object (e.g. "UT", "1".."15"), from its {@code <Tier>} tag.
     *
     * @param id Id of the object.
     * @return Tier string, or "" if unknown/not set.
     */
    public static String getTier(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return "";
        return i.tier;
    }

    /**
     * Flavor-text description of the object, from its {@code <Description>}
     * tag (issue #109 - item tooltips). Not every object carries one.
     *
     * @param id Id of the object.
     * @return Description string, or "" if unknown/not set.
     */
    public static String getDescription(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null) return "";
        return i.description;
    }

    /**
     * Known ground-bag entity object ids for the two tracked BagTypes,
     * verified against the live game the same way upstream Tomato's {@code
     * LootBags} enum is (WHITE=1292, ORANGE=1295 - see {@code
     * upstream/tomato:src/main/java/tomato/realmshark/enums/LootBags.java}).
     * Used only as a fallback in {@link #findBagIconObjectType} when the
     * XML-derived scan below finds nothing: soak testing against the real
     * client (issue soak #113) showed the ground-bag entity's own {@code
     * Object} XML entry does not reliably carry a matching {@code
     * Class=Bag}+{@code BagType} pair, unlike an item's BagType (which does
     * resolve correctly) - so the scan alone silently left {@code
     * lootBagIcons} empty and the Loot panel's category header rendered no
     * sprite at all.
     */
    private static final Map<Integer, Integer> KNOWN_BAG_ICON_IDS = Map.of(6, 1292, 8, 1295);

    /**
     * Finds the ground-bag entity for the given BagType, e.g. the white/orange
     * bag sprite the Loot panel uses as a category header. Resolution order:
     * the real assets' id-name rule ({@link #lootBagEntityTypes()}, preferring
     * a non-boosted entity as the canonical icon), then the legacy
     * {@code Class=Bag}+BagType scan (matches nothing on live assets - soaks
     * #113/#144 - but kept for pre-facts synthetic entries), then {@link
     * #KNOWN_BAG_ICON_IDS} - and only when that id is actually a loaded
     * object, so a minimal/synthetic asset set can't return a dangling id.
     *
     * @param bagType BagType to find the bag entity for.
     * @return that bag entity's object id, or null if none is loaded.
     */
    public static Integer findBagIconObjectType(int bagType) {
        // The real assets' rule first (issue #189): the non-boosted "Loot Bag
        // <N>" entity is the canonical icon for its color.
        Integer named = null;
        for (Map.Entry<Integer, Integer> e : lootBagEntityTypes().entrySet()) {
            if (e.getValue() != bagType) continue;
            IdToAsset entity = objectID.get(e.getKey());
            boolean boosted = entity != null && entity.idName != null && entity.idName.endsWith(" Boost");
            if (!boosted) return e.getKey();
            if (named == null) named = e.getKey();
        }
        if (named != null) return named;
        for (IdToAsset i : objectID.values()) {
            if (i.id > 0 && "Bag".equals(i.clazz) && i.bagType == bagType) {
                return i.id;
            }
        }
        Integer known = KNOWN_BAG_ICON_IDS.get(bagType);
        if (known != null && objectID.containsKey(known)) return known;
        return null;
    }

    /**
     * The real assets' ground-bag encoding rule, discovered from the actual
     * game XML for issue #189: a ground-bag entity's id is {@code "Loot Bag
     * <N>[ Boost]"} where {@code N} IS its BagType (white = "Loot Bag 6" =
     * 1292, orange = "Loot Bag 8" = 1295, plus boosted variants 1296/1727) -
     * class {@code Container}, with no {@code Class=Bag} and no {@code
     * <BagType>} element anywhere on the entity. This replaces the
     * {@code Class=Bag}+BagType scan as the primary discovery mechanism: that
     * scan matches nothing on live assets (soaks #113/#144), and before this
     * rule existed the boosted variants were never recognized at all - a
     * boosted white/orange bag drop was silently invisible to the overlay's
     * drop tracker.
     */
    private static final java.util.regex.Pattern LOOT_BAG_ID_PATTERN =
        java.util.regex.Pattern.compile("^Loot Bag (\\d+)( Boost)?$");

    /**
     * Every loaded ground-bag entity matching {@link #LOOT_BAG_ID_PATTERN},
     * as objectType → BagType. Real or {@code --fake facts-seeded} entries
     * resolve identically, since both carry the real id names.
     */
    public static Map<Integer, Integer> lootBagEntityTypes() {
        Map<Integer, Integer> result = new HashMap<>();
        for (IdToAsset i : objectID.values()) {
            if (i.id <= 0 || i.idName == null) continue;
            java.util.regex.Matcher m = LOOT_BAG_ID_PATTERN.matcher(i.idName);
            if (m.matches()) result.put(i.id, Integer.parseInt(m.group(1)));
        }
        return result;
    }

    /**
     * Parses the projectile string to the number of projectiles the entity can shoot.
     *
     * @return List of parsed projectiles
     */
    private static Projectile[] parseProjectile(String projectile) {
        String[] l = projectile.split(",");
        String s = l[0];
        int slotType = s.isEmpty() ? 0 : Integer.parseInt(s);
        int length = l.length - 1;
        Projectile[] p = new Projectile[length / 3];
        int index = 0;
        for (int i = 0; i < length; i += 3) {
            int min = Integer.parseInt(l[1 + i]);
            int max = Integer.parseInt(l[2 + i]);
            boolean ap = l[3 + i].equals("1");
            p[index] = new Projectile(min, max, ap, slotType);
            index++;
        }

        return p;
    }

    /**
     * Parses the texture string to the texture object.
     *
     * @param entity that should be texture parsed
     * @return List of parsed textures
     */
    private static Texture[] parseObjectTexture(IdToAsset entity) {
        String[] l = entity.texture.split(",");
        Texture[] t = new Texture[l.length / 2];
        int index = 0;
        try {
            for (int i = 0; i < l.length; i += 2) {
                String name = l[i + 1];
                int ix = Integer.parseInt(l[i]);
                t[index] = new Texture(name, ix);
                index++;
            }
        } catch (Exception e) {
//            System.out.println(entity);
        }
        return t;
    }

    /**
     * Gets the damage the tile makes when walking on it.
     *
     * @param id Id of the tile
     * @return Damage of the tile when walking on it
     */
    public static int getTileDamage(int id) {
        IdToAsset i = tileID.get(id);
        if (i == null) return -1;
        return i.tileDmg;
    }

    /**
     * Minimum damage of weapon.
     *
     * @param id           Id of the object.
     * @param projectileId Bullet sub id
     * @return Minimum damage
     */
    public static int getIdProjectileMinDmg(int id, int projectileId) {
        IdToAsset i = objectID.get(id);
        if (i == null || i.projectiles == null || projectileId < 0 || projectileId >= i.projectiles.length) {
            return -1;
        }
        return i.projectiles[projectileId].min;
    }

    /**
     * Maximum damage of weapon.
     *
     * @param id           Id of the object.
     * @param projectileId Bullet sub id
     * @return Maximum damage
     */
    public static int getIdProjectileMaxDmg(int id, int projectileId) {
        IdToAsset i = objectID.get(id);
        if (i == null || i.projectiles == null || projectileId < 0 || projectileId >= i.projectiles.length) {
            return -1;
        }
        return i.projectiles[projectileId].max;
    }

    /**
     * Maximum damage of weapon.
     *
     * @param id           Id of the object.
     * @param projectileId Bullet sub id
     * @return Maximum damage
     */
    public static boolean getIdProjectileArmorPierces(int id, int projectileId) {
        IdToAsset i = objectID.get(id);
        if (i == null || i.projectiles == null || projectileId < 0 || projectileId >= i.projectiles.length) {
            return false;
        }
        return i.projectiles[projectileId].ap;
    }

    /**
     * Inventory slot type of weapon.
     *
     * @param id Id of the weapon.
     * @return Inventory slot type of weapon
     */
    public static int getIdProjectileSlotType(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null || i.projectiles == null || i.projectiles.length == 0) return 0;
        return i.projectiles[0].slotType;
    }

    /**
     * Number of projectiles the object has data for (0 for a non-weapon).
     *
     * @param id Id of the object.
     * @return Projectile count.
     */
    public static int getIdProjectileCount(int id) {
        IdToAsset i = objectID.get(id);
        if (i == null || i.projectiles == null) return 0;
        return i.projectiles.length;
    }

    /**
     * Object texture file name.
     *
     * @param id  Id of the object.
     * @param num Sub texture number
     * @return File name of the texture
     */
    public static String getObjectTextureName(int id, int num) {
        IdToAsset i = objectID.get(id);
        if (i == null) return null;
        if (i.textures == null) i.textures = parseObjectTexture(i);
        try {
            return i.textures[num].name;
        } catch (Exception e) {
            return null;
        }
    }

    /**
     * Object texture file index.
     *
     * @param id  Id of the object.
     * @param num Sub texture number
     * @return File index of the texture
     */
    public static int getObjectTextureIndex(int id, int num) {
        IdToAsset i = objectID.get(id);
        if (i == null) return 0;
        if (i.textures == null) i.textures = parseObjectTexture(i);
        if (i.textures == null) return 0;
        try {
            return i.textures[num].index;
        } catch (ArrayIndexOutOfBoundsException e) {
            System.out.println(id + " " + i);
            return 0;
        }
    }

    /**
     * Tile texture file name.
     *
     * @param id  Id of the object.
     * @param num Sub texture number
     * @return File name of the texture
     */
    public static String getTileTextureName(int id, int num) {
        IdToAsset i = tileID.get(id);
        if (i == null) return null;
        if (i.textures == null) i.textures = parseObjectTexture(i);
        if (i.textures == null) return null;
        return i.textures[num].name;
    }

    /**
     * Tile texture file index.
     *
     * @param id  Id of the object.
     * @param num Sub texture number
     * @return File index of the texture
     */
    public static int getTileTextureIndex(int id, int num) {
        IdToAsset i = tileID.get(id);
        if (i == null) return -1;
        if (i.textures == null) i.textures = parseObjectTexture(i);
        if (i.textures == null) return 0;
        return i.textures[num].index;
    }

    /**
     * Checks if the tile id exists.
     *
     * @param id Id of the tile.
     * @return True if the tile ID exists.
     */
    public static boolean tileIdExists(int id) {
        return tileID.containsKey(id);
    }

    /**
     * Simple class to store projectile info
     */
    private static class Projectile {
        int min; // min dmg
        int max; // max dmg
        boolean ap; // armor piercing
        int slotType; // weapon slot

        public Projectile(int min, int max, boolean ap, int slotType) {
            this.min = min;
            this.max = max;
            this.ap = ap;
            this.slotType = slotType;
        }
    }

    /**
     * Simple class to store texture info
     */
    private static class Texture {
        String name;
        int index;

        public Texture(String name, int index) {
            this.name = name;
            this.index = index;
        }
    }

    public String toString() {
        return l;
    }
}
