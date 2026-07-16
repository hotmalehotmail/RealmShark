package assets.facts;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Covers {@link AssetFactsExtractor} against the REAL XML's structural quirks
 * (issue #189), each verified against an actual game dump before being encoded
 * here: inconsistent hex {@code type} attributes ({@code 0x050C} vs {@code
 * 0x50f}), the ground-bag id-name rule ({@code "Loot Bag <N>[ Boost]"}, class
 * {@code Container}, no {@code <BagType>}), enchantment {@code id}/{@code
 * type} as attributes rather than children, class stat maxima in {@code max}
 * attributes, and the graceful no-dump degradation every asset entry point
 * must honor (see {@code AssetProbeTest}). The synthetic fragments below
 * mirror that verified structure - they are shaped by real assets, but no
 * game content ships in this repo.
 */
public class AssetFactsExtractorTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private AssetFacts extract() throws Exception {
        Path dir = tmp.getRoot().toPath();
        Files.write(dir.resolve("objects.xml"), (""
            + "<Objects>\n"
            // Hex quirk: lowercase, un-zero-padded type - must decode to 1295.
            + "  <Object type=\"0x50f\" id=\"Loot Bag 8\">\n"
            + "    <DisplayId>Loot Bag</DisplayId>\n"
            + "    <Class>Container</Class>\n"
            + "    <Texture><File>lofiObj4</File><Index>0xd7</Index></Texture>\n"
            + "  </Object>\n"
            // Boost variant + zero-padded hex + minimap color (the white bag's marker).
            + "  <Object type=\"0x0510\" id=\"Loot Bag 6 Boost\">\n"
            + "    <Class>Container</Class>\n"
            + "    <MinimapIcon color=\"0xFFFFFF\" piece=\"LootBag\" />\n"
            + "  </Object>\n"
            // An item: BagType/Tier/SlotType children, damage from its Projectile.
            + "  <Object type=\"0x0a1\" id=\"Test Blade\">\n"
            + "    <Class>Equipment</Class>\n"
            + "    <DisplayId>Shiny Test Blade</DisplayId>\n"
            + "    <SlotType>3</SlotType>\n"
            + "    <Tier>12</Tier>\n"
            + "    <BagType>6</BagType>\n"
            + "    <Projectile><MinDamage>100</MinDamage><MaxDamage>150</MaxDamage></Projectile>\n"
            + "  </Object>\n"
            // A player class: stat maxima live in `max` ATTRIBUTES, not text.
            + "  <Object type=\"0x030e\" id=\"Test Wizard\">\n"
            + "    <Class>Player</Class>\n"
            + "    <MaxHitPoints max=\"700\">150</MaxHitPoints>\n"
            + "    <MaxMagicPoints max=\"400\">100</MaxMagicPoints>\n"
            + "    <Attack max=\"60\">16</Attack>\n"
            + "    <Defense max=\"25\">0</Defense>\n"
            + "    <Speed max=\"50\">10</Speed>\n"
            + "    <Dexterity max=\"75\">15</Dexterity>\n"
            + "    <HpRegen max=\"40\">5</HpRegen>\n"
            + "    <MpRegen max=\"60\">10</MpRegen>\n"
            + "    <Equipment>2711, 2606, -1</Equipment>\n"
            + "  </Object>\n"
            + "</Objects>\n").getBytes(StandardCharsets.UTF_8));
        // id/type are ATTRIBUTES on real Enchantment elements; two mutators multiply.
        Files.write(dir.resolve("enchantments.xml"), (""
            + "<Enchantments>\n"
            + "  <Enchantment id=\"Attack_Bonus_1\" type=\"0x107\">\n"
            + "    <DisplayId>Attack Bonus I</DisplayId>\n"
            + "    <Description>Increases Attack by 1.4</Description>\n"
            + "    <Mutators>\n"
            + "      <MultiplyMinDamage projectileId=\"-1\">1.02</MultiplyMinDamage>\n"
            + "      <MultiplyMinDamage projectileId=\"-1\">2</MultiplyMinDamage>\n"
            + "    </Mutators>\n"
            + "  </Enchantment>\n"
            + "</Enchantments>\n").getBytes(StandardCharsets.UTF_8));
        // Decoy: an <Enchantment> under a different root - ParseEnchants only
        // reads enchantments.xml, so the facts must not collect this one.
        Files.write(dir.resolve("enchantmentLists.xml"), (""
            + "<EnchantmentLists>\n"
            + "  <Enchantment id=\"Decoy\" type=\"0x999\" />\n"
            + "</EnchantmentLists>\n").getBytes(StandardCharsets.UTF_8));
        return AssetFactsExtractor.run(dir, "test-build", new PrintStream(new ByteArrayOutputStream()));
    }

    @Test
    public void decodesInconsistentHexAndAppliesTheBagNameRule() throws Exception {
        AssetFacts facts = extract();
        AssetFacts.Entity orange = facts.entities.get("1295"); // 0x50f
        assertEquals("Loot Bag 8", orange.name);
        assertEquals(8, orange.bagType);
        assertFalse(orange.boosted);
        assertEquals("Container", orange.clazz);
        assertEquals("lofiObj4", orange.textureFile);
        assertEquals(0xd7, orange.textureIndex);

        AssetFacts.Entity boostedWhite = facts.entities.get("1296"); // 0x0510
        assertEquals(6, boostedWhite.bagType);
        assertTrue(boostedWhite.boosted);
        assertEquals("0xFFFFFF", boostedWhite.minimapColor);
    }

    @Test
    public void extractsItemFieldsTheCodeConsumes() throws Exception {
        AssetFacts.Item item = extract().items.get("161"); // 0x0a1
        assertEquals("Test Blade", item.name);
        assertEquals("Shiny Test Blade", item.displayId);
        assertEquals(6, item.bagType);
        assertEquals("12", item.tier);
        assertEquals(3, item.slotType);
        assertArrayEquals(new int[] { 100, 150 }, item.damage);
    }

    @Test
    public void extractsClassStatMaximaFromMaxAttributes() throws Exception {
        AssetFacts.PlayerClass wizard = extract().classes.get("782"); // 0x030e
        assertEquals("Test Wizard", wizard.name);
        assertEquals(Integer.valueOf(700), wizard.maxStats.get("life"));
        assertEquals(Integer.valueOf(75), wizard.maxStats.get("dex"));
        assertArrayEquals(new int[] { 2711, 2606, -1 }, wizard.equipment);
    }

    @Test
    public void readsEnchantIdAndTypeFromAttributesAndMultipliesMutators() throws Exception {
        AssetFacts facts = extract();
        AssetFacts.Enchant enchant = facts.enchants.get("263"); // 0x107
        assertEquals("Attack_Bonus_1", enchant.name);
        assertEquals("Attack Bonus I", enchant.displayId);
        assertEquals(1.02f * 2f, enchant.minDamageMult, 1e-6);
        assertNull(enchant.maxDamageMult);
        assertNull("Enchantment under a non-Enchantments root must be ignored",
            facts.enchants.get("2457")); // 0x999 decoy
    }

    @Test
    public void missingDumpDegradesToStatusMessageNotACrash() {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AssetFacts facts = AssetFactsExtractor.run(
            Paths.get("/definitely/not/a/real/xml-dump"), "b", new PrintStream(buf));
        assertNull(facts);
        assertTrue(buf.toString().contains("nothing extracted"));
    }

    @Test
    public void writtenJsonRoundTripsThroughTheLoader() throws Exception {
        AssetFacts facts = extract();
        StringWriter sw = new StringWriter();
        AssetFactsExtractor.write(facts, sw);
        Path out = tmp.newFile("roundtrip.json").toPath();
        Files.write(out, sw.toString().getBytes(StandardCharsets.UTF_8));
        AssetFacts reloaded = AssetFacts.load(out);
        assertEquals("test-build", reloaded.gameBuild);
        assertEquals(facts.entities.size(), reloaded.entities.size());
        assertEquals("Loot Bag 8", reloaded.entities.get("1295").name);
        assertEquals("Container", reloaded.entities.get("1295").clazz);
    }
}
