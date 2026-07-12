package assets.resextractor;

import assets.flattbuffer.SpriteSheetRoot;
import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.TreeMap;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Diagnostic-only feasibility probe for issue #107, part 2. The overlay's
 * enchant rarity feature (part 1) only needs enchant *counts*, computable
 * headlessly with no game assets - but rendering the game's own enchant
 * "pip"/per-enchantment icon art (a follow-up feature) needs to know whether
 * that art is even reachable in the extraction pipeline, and if so, where.
 * This probe answers that with three read-only reports over whatever the
 * extraction pipeline ({@link UnityExtractor}/{@link Resources}) already
 * walks - it writes nothing, and degrades to a clear "not available" message
 * (never a crash) when no game assets are present, which is the normal case
 * on CI and most dev machines. See docs/asset-pipeline.md for how to run it
 * and read the output.
 */
public class AssetProbe {

    /** assets/xml/enchantments.xml's path, matching {@code bridge.dps.ParseEnchants.ENCHANT_XML_PATH}. */
    private static final String ENCHANTMENTS_XML_PATH = "assets/xml/enchantments.xml";

    /** Case-insensitive substrings that flag a texture/sheet/XML-tag name as pip/icon-art relevant. */
    private static final String[] SEARCH_PATTERNS = { "enchant", "pip", "rarity", "engrave" };

    /** XML child tag names {@code bridge.dps.ParseEnchants#loadEnchants} actually reads. */
    private static final List<String> PARSED_BY_PARSE_ENCHANTS = List.of(
        "Enchantment",
        "id",
        "type",
        "Mutators"
    );

    /**
     * Runs all three reports against {@code assetsFile} (typically
     * {@code assets.AssetExtractor.assetFile()}), writing plain-text, greppable
     * output to {@code out}. Never throws: a missing/unreadable
     * {@code resources.assets} (no game installed - the CI/dev-sandbox default)
     * or a missing {@code enchantments.xml} each report a clear status line and
     * the probe continues with whatever else it can report.
     */
    public static void run(File assetsFile, PrintStream out) {
        out.println("=== RealmShark asset probe (issue #107 part 2: enchant pip/icon feasibility) ===");
        if (assetsFile == null || !assetsFile.exists()) {
            out.println("STATUS: no resources.assets found - game not installed, or the path didn't resolve.");
            out.println("Sections 1-2 need a real game install; run this probe on a machine with RotMG installed.");
        } else {
            out.println("resources.assets: " + assetsFile.getAbsolutePath());
            Resources res;
            try {
                res = new Resources(assetsFile);
            } catch (IOException | RuntimeException e) {
                res = null;
                out.println("STATUS: failed to parse resources.assets: " + e);
            }
            if (res != null) {
                probeTextures(res, out);
                probeSpritesheet(res, out);
            }
        }
        probeEnchantmentsXml(new File(ENCHANTMENTS_XML_PATH), out);
        out.println("=== end probe ===");
    }

    /** Section 1: every Texture2D asset name in resources.assets, not just the four we extract. */
    private static void probeTextures(Resources res, PrintStream out) {
        out.println();
        out.println(
            "--- 1. Texture2D assets in resources.assets (" + res.assetTexture2D.size() + " total) ---");
        out.println("Extracted today (Texture2D.SPRITESHEET_NAMES): " + java.util.Arrays.toString(
            Texture2D.SPRITESHEET_NAMES));
        List<String> flagged = new ArrayList<>();
        for (Texture2D t : res.assetTexture2D) {
            boolean matches = matchesAny(t.name);
            out.println((matches ? "* " : "  ") + "TEXTURE2D\t" + t.name + "\t" + t.m_Width + "x" + t.m_Height);
            if (matches) flagged.add(t.name);
        }
        out.println("Flagged (enchant/pip/rarity/engrave match): " + (flagged.isEmpty() ? "none" : flagged));
    }

    /** Section 2: every sheet name in the spritesheetf FlatBuffers manifest. */
    private static void probeSpritesheet(Resources res, PrintStream out) {
        out.println();
        if (res.spritesheet == null || res.spritesheet.m_Script == null) {
            out.println("--- 2. spritesheetf sheet names --- NOT FOUND (no spritesheetf TextAsset in resources.assets)");
            return;
        }
        SpriteSheetRoot ssr;
        try {
            ssr = SpriteSheetRoot.getRootAsSpriteSheetRoot(ByteBuffer.wrap(res.spritesheet.m_Script));
        } catch (RuntimeException e) {
            out.println("--- 2. spritesheetf sheet names --- FAILED to parse FlatBuffer: " + e);
            return;
        }
        int staticCount = ssr.spritesLength();
        int animatedCount = ssr.animatedSpritesLength();
        out.println(
            "--- 2. spritesheetf sheet names (" + staticCount + " static sheets, "
                + animatedCount + " animated entries) ---");
        TreeSet<String> seen = new TreeSet<>();
        List<String> flagged = new ArrayList<>();
        for (int i = 0; i < staticCount; i++) {
            String name = ssr.sprites(i).name();
            if (name == null || !seen.add(name)) continue;
            boolean matches = matchesAny(name);
            out.println((matches ? "* " : "  ") + "SHEET\t" + name);
            if (matches) flagged.add(name);
        }
        for (int i = 0; i < animatedCount; i++) {
            String name = ssr.animatedSprites(i).name();
            if (name == null || !seen.add(name)) continue;
            boolean matches = matchesAny(name);
            out.println((matches ? "* " : "  ") + "SHEET(animated)\t" + name);
            if (matches) flagged.add(name);
        }
        out.println("Flagged (enchant/pip/rarity/engrave match): " + (flagged.isEmpty() ? "none" : flagged));
    }

    /**
     * Section 3: XML child tags seen under assets/xml/enchantments.xml, flagging
     * every tag {@code ParseEnchants.loadEnchants} does NOT read (candidates for
     * icon/texture references) and every tag that looks icon/texture-related by
     * name regardless. A plain regex scan (not a DOM parse) is enough for a
     * diagnostic report and keeps this a read-only logging pass, matching how
     * {@code UnityExtractor} is otherwise just walked/logged for this probe.
     */
    static void probeEnchantmentsXml(File xmlFile, PrintStream out) {
        out.println();
        out.println("--- 3. " + xmlFile.getPath() + " icon/texture references ---");
        if (!xmlFile.exists()) {
            out.println(
                "NOT FOUND: " + xmlFile.getAbsolutePath()
                    + " (extraction hasn't run, or this game version has no such file)");
            return;
        }
        String content;
        try {
            content = new String(Files.readAllBytes(xmlFile.toPath()), StandardCharsets.UTF_8);
        } catch (IOException e) {
            out.println("ERROR reading " + xmlFile.getAbsolutePath() + ": " + e);
            return;
        }
        Map<String, Integer> tagCounts = new TreeMap<>();
        Matcher tagMatcher = Pattern.compile("<([A-Za-z_][\\w]*)[ >/]").matcher(content);
        while (tagMatcher.find()) {
            tagCounts.merge(tagMatcher.group(1), 1, Integer::sum);
        }
        out.println("Distinct XML tags seen (" + tagCounts.size() + "):");
        List<String> unparsed = new ArrayList<>();
        for (Map.Entry<String, Integer> e : tagCounts.entrySet()) {
            String tag = e.getKey();
            boolean isParsed = PARSED_BY_PARSE_ENCHANTS.contains(tag);
            boolean looksIconLike = matchesAny(tag)
                || tag.toLowerCase(Locale.ROOT).contains("tex")
                || tag.toLowerCase(Locale.ROOT).contains("icon")
                || tag.toLowerCase(Locale.ROOT).contains("image");
            out.println((looksIconLike ? "* " : "  ") + "TAG\t" + tag + "\t" + e.getValue());
            if (!isParsed) unparsed.add(tag);
        }
        out.println(
            "Tags NOT read by ParseEnchants.loadEnchants (candidates for icon/pip fields): " + unparsed);
    }

    private static boolean matchesAny(String name) {
        if (name == null) return false;
        String lower = name.toLowerCase(Locale.ROOT);
        for (String pattern : SEARCH_PATTERNS) {
            if (lower.contains(pattern)) return true;
        }
        return false;
    }
}
