package assets.facts;

import com.google.gson.Gson;

import java.io.IOException;
import java.io.PrintStream;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilder;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.w3c.dom.NodeList;

/**
 * Maintainer-run distiller (PRD "Agent Observability" §7.4, issue #189): reads
 * an extracted game XML dump (the {@code assets/xml/} layout
 * {@link assets.AssetExtractor} writes on a machine with the game installed)
 * and writes the facts-only JSON {@link AssetFacts} describes - ids, names,
 * and numeric fields the code consumes; no sprite/art data, no shipped assets.
 * The dump itself is never committed or published; only this distillation is.
 *
 * <pre>
 *   ./gradlew extractFacts -PxmlDir=$HOME/rotmg-assets/xml [-Pbuild=&lt;exalt build id&gt;]
 * </pre>
 *
 * <p>Follows this pipeline's graceful-degradation contract: a missing/empty
 * XML directory (no game dump on this machine - the CI/dev default) produces a
 * clear status message, never a crash; {@code main} then exits nonzero so a
 * scripted run can't mistake it for success.
 *
 * <p>Real-XML quirks this parser must (and tests verify it does) survive:
 * {@code type} attributes in inconsistent hex ({@code 0x050C} vs {@code 0x50f}
 * vs decimal), enchantment {@code id}/{@code type} as XML <em>attributes</em>,
 * class stat maxima as {@code max} attributes, and the ground-bag entities
 * encoding their BagType only in the id string ({@code "Loot Bag <N>[ Boost]"},
 * class {@code Container} - there is no {@code Class=Bag} or {@code <BagType>}
 * on any real bag entity; soak #113/#144).
 */
public final class AssetFactsExtractor {

    /**
     * The real ground-bag naming rule: id "Loot Bag &lt;N&gt;[ Boost]", N = BagType.
     * Deliberately BROADER than {@code IdToAsset.LOOT_BAG_ID_PATTERN}, the runtime
     * discovery rule: the extractor also captures the numberless family members
     * ("Soulbound Loot Bag", recorded with bagType -1) so the facts describe the
     * full container family, while the runtime rule tracks only the numbered
     * entities whose suffix IS their BagType. Don't "sync" one to the other.
     */
    static final Pattern LOOT_BAG_ID = Pattern.compile("^(Soulbound )?Loot Bag(?: (\\d+))?( Boost)?$");

    private static final String GENERATOR = "AssetFactsExtractor v1";
    private static final String DEFAULT_OUT = "src/main/resources/" + AssetFacts.RESOURCE_PATH;

    private AssetFactsExtractor() {}

    public static void main(String[] args) throws IOException {
        String xmlDir = argValue(args, "--xml");
        String out = argValue(args, "--out");
        String build = argValue(args, "--build");
        if (out == null || out.isEmpty()) out = DEFAULT_OUT;

        AssetFacts facts = run(
            xmlDir == null || xmlDir.isEmpty() ? null : Paths.get(xmlDir),
            build == null || build.isEmpty() ? "unknown" : build,
            System.out
        );
        if (facts == null) System.exit(2);

        Path outPath = Paths.get(out);
        if (outPath.getParent() != null) Files.createDirectories(outPath.getParent());
        try (Writer w = Files.newBufferedWriter(outPath, StandardCharsets.UTF_8)) {
            write(facts, w);
        }
        System.out.println("asset-facts: wrote " + outPath + " (" + Files.size(outPath) + " bytes)");
    }

    /**
     * Distills {@code xmlDir} into an {@link AssetFacts}, printing a summary
     * (or a clear "nothing to extract" status) to {@code out}. Never throws on
     * missing input; returns null in that case.
     */
    public static AssetFacts run(Path xmlDir, String build, PrintStream out) {
        if (xmlDir == null || !Files.isDirectory(xmlDir)) {
            out.println("asset-facts: no XML directory found at "
                + (xmlDir == null ? "(none given - pass -PxmlDir=...)" : xmlDir)
                + " - nothing extracted. Point it at an extracted assets/xml dump.");
            return null;
        }

        List<Path> files = new ArrayList<>();
        try {
            Files.walk(xmlDir)
                .filter(Files::isRegularFile)
                .filter(p -> p.toString().endsWith(".xml"))
                .sorted(Comparator.comparing(Path::toString))
                .forEach(files::add);
        } catch (IOException e) {
            out.println("asset-facts: cannot read " + xmlDir + " (" + e.getMessage() + ") - nothing extracted.");
            return null;
        }
        if (files.isEmpty()) {
            out.println("asset-facts: no .xml files under " + xmlDir + " - nothing extracted.");
            return null;
        }

        AssetFacts facts = new AssetFacts();
        facts.gameBuild = build;
        facts.extractedAt = LocalDate.now().toString();
        facts.generator = GENERATOR;
        facts.items = new TreeMap<>(Comparator.comparingInt(Integer::parseInt));
        facts.entities = new TreeMap<>(Comparator.comparingInt(Integer::parseInt));
        facts.enchants = new TreeMap<>(Comparator.comparingInt(Integer::parseInt));
        facts.classes = new TreeMap<>(Comparator.comparingInt(Integer::parseInt));

        int parseFailures = 0;
        int duplicates = 0;
        MessageDigest digest = sha256();

        for (Path p : files) {
            byte[] bytes;
            try {
                bytes = Files.readAllBytes(p);
            } catch (IOException e) {
                parseFailures++;
                continue;
            }
            digest.update(p.getFileName().toString().getBytes(StandardCharsets.UTF_8));
            digest.update(bytes);

            Document doc;
            try {
                doc = newDocumentBuilder().parse(new java.io.ByteArrayInputStream(bytes));
            } catch (Exception e) {
                // Same posture as AssetExtractor.parseXML: a malformed file is
                // skipped, not fatal - but unlike there, it is counted and reported.
                parseFailures++;
                continue;
            }
            duplicates += collectObjects(doc, facts);
            collectEnchants(doc, facts);
        }

        facts.sourceHash = hex(digest.digest()).substring(0, 12);

        out.println("asset-facts: parsed " + files.size() + " files ("
            + parseFailures + " unparseable, skipped; " + duplicates + " duplicate ids, first kept)");
        out.println("asset-facts: items=" + facts.items.size()
            + " entities=" + facts.entities.size()
            + " enchants=" + facts.enchants.size()
            + " classes=" + facts.classes.size()
            + " sourceHash=" + facts.sourceHash);
        return facts;
    }

    /** Serializes with one compact line per entry - reviewable diffs without pretty-printing 100k lines. */
    static void write(AssetFacts facts, Writer w) throws IOException {
        Gson gson = new Gson();
        w.write("{\n");
        w.write("  \"gameBuild\": " + gson.toJson(facts.gameBuild) + ",\n");
        w.write("  \"extractedAt\": " + gson.toJson(facts.extractedAt) + ",\n");
        w.write("  \"generator\": " + gson.toJson(facts.generator) + ",\n");
        w.write("  \"sourceHash\": " + gson.toJson(facts.sourceHash) + ",\n");
        writeSection(gson, w, "items", facts.items, ",");
        writeSection(gson, w, "entities", facts.entities, ",");
        writeSection(gson, w, "enchants", facts.enchants, ",");
        writeSection(gson, w, "classes", facts.classes, "");
        w.write("}\n");
    }

    private static void writeSection(Gson gson, Writer w, String name, Map<String, ?> map, String trailer)
        throws IOException {
        w.write("  \"" + name + "\": {\n");
        int i = 0;
        for (Map.Entry<String, ?> e : map.entrySet()) {
            w.write("    \"" + e.getKey() + "\": " + gson.toJson(e.getValue()));
            w.write(++i < map.size() ? ",\n" : "\n");
        }
        w.write("  }" + trailer + "\n");
    }

    /** Walks every {@code <Object>} element into items / entities / classes. Returns the duplicate-id count. */
    private static int collectObjects(Document doc, AssetFacts facts) {
        int duplicates = 0;
        NodeList objects = doc.getElementsByTagName("Object");
        for (int i = 0; i < objects.getLength(); i++) {
            Element el = (Element) objects.item(i);
            Integer type = decodeType(el.getAttribute("type"));
            String id = el.getAttribute("id");
            if (type == null || id.isEmpty()) continue;
            String key = String.valueOf(type);
            String clazz = childText(el, "Class");

            Matcher bag = LOOT_BAG_ID.matcher(id);
            if (bag.matches()) {
                if (facts.entities.containsKey(key)) {
                    duplicates++;
                    continue;
                }
                AssetFacts.Entity entity = new AssetFacts.Entity();
                entity.name = id;
                entity.displayId = differingDisplayId(el, id);
                entity.clazz = clazz;
                entity.bagType = bag.group(2) == null ? -1 : Integer.parseInt(bag.group(2));
                entity.boosted = bag.group(3) != null;
                Element tex = firstChild(el, "Texture");
                if (tex != null) {
                    entity.textureFile = childText(tex, "File");
                    Integer idx = decodeType(childText(tex, "Index"));
                    entity.textureIndex = idx == null ? -1 : idx;
                }
                Element minimap = firstChild(el, "MinimapIcon");
                if (minimap != null && !minimap.getAttribute("color").isEmpty()) {
                    entity.minimapColor = minimap.getAttribute("color");
                }
                facts.entities.put(key, entity);
                continue;
            }

            if ("Player".equals(clazz)) {
                if (facts.classes.containsKey(key)) {
                    duplicates++;
                    continue;
                }
                AssetFacts.PlayerClass pc = new AssetFacts.PlayerClass();
                pc.name = id;
                pc.maxStats = new TreeMap<>();
                pc.maxStats.put("life", maxAttr(el, "MaxHitPoints"));
                pc.maxStats.put("mana", maxAttr(el, "MaxMagicPoints"));
                pc.maxStats.put("atk", maxAttr(el, "Attack"));
                pc.maxStats.put("def", maxAttr(el, "Defense"));
                pc.maxStats.put("spd", maxAttr(el, "Speed"));
                pc.maxStats.put("dex", maxAttr(el, "Dexterity"));
                pc.maxStats.put("vit", maxAttr(el, "HpRegen"));
                pc.maxStats.put("wis", maxAttr(el, "MpRegen"));
                pc.equipment = parseIntList(childText(el, "Equipment"));
                facts.classes.put(key, pc);
                continue;
            }

            String bagTypeRaw = childText(el, "BagType");
            if (bagTypeRaw.isEmpty() && !"Equipment".equals(clazz)) continue;
            if (facts.items.containsKey(key)) {
                duplicates++;
                continue;
            }
            AssetFacts.Item item = new AssetFacts.Item();
            item.name = id;
            item.displayId = differingDisplayId(el, id);
            Integer bt = decodeType(bagTypeRaw);
            item.bagType = bt == null ? -1 : bt;
            String tier = childText(el, "Tier");
            if (!tier.isEmpty()) item.tier = tier;
            Integer slot = decodeType(childText(el, "SlotType"));
            item.slotType = slot == null ? 0 : slot;
            Element proj = firstChild(el, "Projectile");
            if (proj == null) proj = firstChild(el, "Subattack");
            if (proj != null) {
                Integer min = decodeType(childText(proj, "MinDamage"));
                Integer max = decodeType(childText(proj, "MaxDamage"));
                if (min != null && max != null) item.damage = new int[] { min, max };
            }
            facts.items.put(key, item);
        }
        return duplicates;
    }

    /**
     * Walks every {@code <Enchantment>} element; id/type are ATTRIBUTES on real
     * assets. Scoped to documents rooted {@code <Enchantments>} - the one file
     * {@code bridge.dps.ParseEnchants} actually reads (enchantments.xml).
     */
    private static void collectEnchants(Document doc, AssetFacts facts) {
        if (!"Enchantments".equals(doc.getDocumentElement().getNodeName())) return;
        NodeList enchants = doc.getElementsByTagName("Enchantment");
        for (int i = 0; i < enchants.getLength(); i++) {
            Element el = (Element) enchants.item(i);
            Integer type = decodeType(el.getAttribute("type"));
            String id = el.getAttribute("id");
            if (type == null || id.isEmpty() || facts.enchants.containsKey(String.valueOf(type))) continue;
            AssetFacts.Enchant enchant = new AssetFacts.Enchant();
            enchant.name = id;
            enchant.displayId = differingDisplayId(el, id);
            String desc = childText(el, "Description");
            if (!desc.isEmpty()) enchant.description = desc;
            Element mutators = firstChild(el, "Mutators");
            if (mutators != null) {
                enchant.minDamageMult = mutatorProduct(mutators, "MultiplyMinDamage");
                enchant.maxDamageMult = mutatorProduct(mutators, "MultiplyMaxDamage");
                enchant.rateOfFireMult = mutatorProduct(mutators, "MultiplyRateOfFire");
            }
            facts.enchants.put(String.valueOf(type), enchant);
        }
    }

    /** Product of all {@code tag} mutator values (ParseEnchants multiplies them), or null when none parse. */
    private static Float mutatorProduct(Element mutators, String tag) {
        float product = 1f;
        boolean any = false;
        NodeList list = mutators.getElementsByTagName(tag);
        for (int i = 0; i < list.getLength(); i++) {
            try {
                product *= Float.parseFloat(list.item(i).getTextContent().trim());
                any = true;
            } catch (NumberFormatException ignore) {
                // non-numeric mutator body: skipped, same as ParseEnchants.readNumericChild's fallback
            }
        }
        return any ? product : null;
    }

    /** The element's DisplayId when present and different from {@code id}, else null (keeps the file lean). */
    private static String differingDisplayId(Element el, String id) {
        String display = childText(el, "DisplayId");
        return display.isEmpty() || display.equals(id) ? null : display;
    }

    /** {@code max} attribute of the first {@code tag} child - how CharacterClass reads stat maxima. */
    private static Integer maxAttr(Element el, String tag) {
        Element child = firstChild(el, tag);
        if (child == null) return 0;
        Integer v = decodeType(child.getAttribute("max"));
        return v == null ? 0 : v;
    }

    private static int[] parseIntList(String csv) {
        if (csv == null || csv.trim().isEmpty()) return new int[0];
        String[] parts = csv.split(",");
        List<Integer> vals = new ArrayList<>();
        for (String part : parts) {
            Integer v = decodeType(part.trim());
            if (v != null) vals.add(v);
        }
        int[] out = new int[vals.size()];
        for (int i = 0; i < out.length; i++) out[i] = vals.get(i);
        return out;
    }

    /**
     * Decodes a numeric attribute that real assets write inconsistently -
     * {@code 0x050C}, {@code 0x50f}, or plain decimal. Null when absent/invalid.
     */
    static Integer decodeType(String raw) {
        if (raw == null || raw.trim().isEmpty()) return null;
        try {
            return Integer.decode(raw.trim());
        } catch (NumberFormatException e) {
            return null;
        }
    }

    /** Text content of the first direct or nested {@code tag} child, or "". */
    private static String childText(Element el, String tag) {
        Element child = firstChild(el, tag);
        return child == null || child.getTextContent() == null ? "" : child.getTextContent().trim();
    }

    /** First DIRECT child element named {@code tag} (avoids e.g. a nested Projectile's MinDamage leaking upward). */
    private static Element firstChild(Element el, String tag) {
        for (Node n = el.getFirstChild(); n != null; n = n.getNextSibling()) {
            if (n.getNodeType() == Node.ELEMENT_NODE && tag.equals(n.getNodeName())) return (Element) n;
        }
        return null;
    }

    private static DocumentBuilder newDocumentBuilder() throws Exception {
        DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
        // The dump is local trusted input, but there is no reason to resolve
        // DTDs/entities - and CI must never make a network fetch from here.
        factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
        factory.setFeature("http://apache.org/xml/features/nonvalidating/load-external-dtd", false);
        return factory.newDocumentBuilder();
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static String hex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) sb.append(String.format("%02x", b));
        return sb.toString();
    }

    private static String argValue(String[] args, String flag) {
        for (int i = 0; i < args.length - 1; i++) {
            if (flag.equals(args[i])) return args[i + 1];
        }
        return null;
    }
}
