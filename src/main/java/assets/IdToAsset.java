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
     */
    public IdToAsset(String l, int id, String idName, String display, String clazz, Projectile[] projectiles, String texture, String label, String group, String bagType, String tier, String description) {
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
        IdToAsset entry = new IdToAsset(
            "", id, "Fake" + id, display == null ? "" : display, clazz, null, "", "", "",
            String.valueOf(bagType), tier == null ? "" : tier, description == null ? "" : description
        );
        fakeEntries.put(id, entry);
        objectID.put(id, entry);
    }

    /** Parses a raw {@code <BagType>} string (decimal or 0x-hex) to an int, or -1 if blank/unparseable. */
    private static int parseBagType(String raw) {
        if (raw == null || raw.isEmpty()) return -1;
        try {
            return raw.startsWith("0x") ? Integer.decode(raw) : Integer.parseInt(raw.trim());
        } catch (Exception e) {
            return -1;
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
                // bagType/tier/description are newer columns - default "" for an
                // older ObjectID.list written before they existed.
                String bagType = l.length > 8 ? l[8] : "";
                String tier = l.length > 9 ? l[9] : "";
                String description = l.length > 10 ? l[10] : "";
                objectID.put(id, new IdToAsset(line, id, idName, display, clazz, projectiles, texture, label, group, bagType, tier, description));
            }
            br.close();
        } catch (Exception e) {
            System.out.println(lineCheck);
            e.printStackTrace();
        }

        objectID.put(-1, new IdToAsset("", -1, "Unloaded", "Unloaded", "", null, "", "", "Unloaded", "", "", ""));
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
     * Finds the ground-bag entity ({@code <Class>Bag</Class>}) that
     * self-identifies as the given BagType, e.g. the white/orange bag sprite
     * the Loot panel uses as a category header. Prefers asset-derived data
     * (real or {@code --fake}-registered); falls back to {@link
     * #KNOWN_BAG_ICON_IDS} - and only when that id is actually a loaded
     * object, so a minimal/synthetic asset set can't return a dangling id -
     * when the scan finds no match.
     *
     * @param bagType BagType to find the bag entity for.
     * @return that bag entity's object id, or null if none is loaded.
     */
    public static Integer findBagIconObjectType(int bagType) {
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
