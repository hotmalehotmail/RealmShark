package assets.facts;

import com.google.gson.Gson;
import com.google.gson.annotations.SerializedName;

import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

/**
 * The distilled real-asset facts file (PRD "Agent Observability" §7.4, issue
 * #189): only the fields the code actually consumes, extracted from a real
 * game install's XML dump by {@link AssetFactsExtractor} and committed as the
 * classpath resource {@code assets/facts/asset-facts.json}. Ground truth for
 * headless tests and for {@code --fake} mode's {@code IdToAsset.registerFake}
 * seeding, replacing invented values whose divergence from real assets caused
 * the loot saga (issue #105 → soaks #113/#122/#136/#144).
 *
 * <p>Never contains shipped game assets - ids, names, and numeric fields only.
 * The maintainer reruns the extractor per game update; {@link #gameBuild} /
 * {@link #sourceHash} make staleness detectable.
 */
public class AssetFacts {

    /** Classpath location of the committed facts file (inside the built jars). */
    public static final String RESOURCE_PATH = "assets/facts/asset-facts.json";

    public String gameBuild;
    public String extractedAt;
    public String generator;
    /** Short SHA-256 over the source XML dump, so "did the dump change" is answerable without the dump. */
    public String sourceHash;

    /** Keyed by decimal objectType. Objects carrying a {@code <BagType>} or {@code <Class>Equipment}. */
    public Map<String, Item> items;
    /** Keyed by decimal objectType. The ground-bag container entities ("Loot Bag N[ Boost]"). */
    public Map<String, Entity> entities;
    /** Keyed by decimal enchantment type. */
    public Map<String, Enchant> enchants;
    /** Keyed by decimal player-class objectType. */
    public Map<String, PlayerClass> classes;

    public static class Item {
        public String name;
        /** Only present when it differs from {@link #name}. */
        public String displayId;
        /** -1 when the element has no {@code <BagType>}. */
        public int bagType = -1;
        public String tier;
        public int slotType;
        /** First projectile's [min, max], or null for non-weapons. */
        public int[] damage;
    }

    public static class Entity {
        public String name;
        public String displayId;
        /** The REAL class - {@code Container} on live assets, never {@code Bag} (soak #113/#144). */
        @SerializedName("class")
        public String clazz;
        /**
         * Derived from the id's numeric suffix - the real encoding rule
         * ({@code "Loot Bag <N>[ Boost]"} where N is the BagType); -1 when the
         * id carries no number (e.g. "Soulbound Loot Bag").
         */
        public int bagType = -1;
        public boolean boosted;
        public String textureFile;
        public int textureIndex = -1;
        /** {@code <MinimapIcon color>} when present (white bag = 0xFFFFFF). */
        public String minimapColor;
    }

    public static class Enchant {
        public String name;
        public String displayId;
        public String description;
        /** DPS mutators {@code bridge.dps.ParseEnchants} consumes; null when the enchant has none (multiplier 1). */
        public Float minDamageMult;
        public Float maxDamageMult;
        public Float rateOfFireMult;
    }

    public static class PlayerClass {
        public String name;
        /** The 8 stat maxima {@code CharacterClass} reads ({@code max} attribute): life, mana, atk, def, spd, dex, vit, wis. */
        public Map<String, Integer> maxStats;
        /** {@code <Equipment>} item ids (first = starting weapon, which seeds the weapon-group mapping). */
        public int[] equipment;
    }

    /**
     * Loads the committed facts from the classpath, or null when the resource
     * is absent (a build predating the facts file) - callers degrade to their
     * legacy behavior rather than crash.
     */
    public static AssetFacts loadBundled() {
        InputStream in = AssetFacts.class.getClassLoader().getResourceAsStream(RESOURCE_PATH);
        if (in == null) return null;
        try (Reader r = new InputStreamReader(in, StandardCharsets.UTF_8)) {
            return new Gson().fromJson(r, AssetFacts.class);
        } catch (Exception e) {
            return null;
        }
    }

    /** Loads a facts file from disk (extractor output verification, tests). Null when missing/invalid. */
    public static AssetFacts load(Path file) {
        try (Reader r = Files.newBufferedReader(file, StandardCharsets.UTF_8)) {
            return new Gson().fromJson(r, AssetFacts.class);
        } catch (Exception e) {
            return null;
        }
    }
}
