package bridge.dps;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import assets.facts.AssetFacts;
import java.io.File;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Facts-driven ParseEnchants coverage (issue #189, acceptance criterion 3):
 * feeds REAL enchant records - name, type id, and DPS mutator values from the
 * committed {@code asset-facts.json}, written in the verified real XML
 * structure ({@code id}/{@code type} as ATTRIBUTES on {@code <Enchantment>},
 * mutator values as element text) - through the real
 * {@code assets/xml/enchantments.xml} → {@link ParseEnchants#reload()} path,
 * and asserts the parser resolves exactly what the facts say. Before this,
 * ParseEnchants was only ever tested against invented fragments, the
 * loot-saga class of circular validation; a game update that changes enchant
 * semantics now breaks this test at the next facts refresh instead of in a
 * live soak. File-on-disk discipline mirrors {@link ParseEnchantsReloadTest}.
 */
public class ParseEnchantsFactsTest {

    private static final File XML_FILE = new File("assets/xml/enchantments.xml");

    @Before
    public void removeEnchantmentsXml() throws IOException {
        Files.deleteIfExists(XML_FILE.toPath());
    }

    @After
    public void cleanup() throws IOException {
        Files.deleteIfExists(XML_FILE.toPath());
        ParseEnchants.reload(); // leave no stale real-facts state for other tests
    }

    /** Lowest-typed facts enchant with a min-damage mutator - deterministic across runs. */
    private static Map.Entry<String, AssetFacts.Enchant> damageEnchant(AssetFacts facts) {
        return facts.enchants.entrySet().stream()
            .filter(e -> e.getValue().minDamageMult != null)
            .min((a, b) -> Integer.compare(Integer.parseInt(a.getKey()), Integer.parseInt(b.getKey())))
            .orElseThrow(() -> new AssertionError("facts carry no damage-mutator enchant"));
    }

    @Test
    public void resolvesRealEnchantNameAndDamageMultipliersFromFacts() throws IOException {
        AssetFacts facts = AssetFacts.loadBundled();
        assertNotNull("committed asset-facts.json missing", facts);
        Map.Entry<String, AssetFacts.Enchant> entry = damageEnchant(facts);
        short type = Short.parseShort(entry.getKey());
        AssetFacts.Enchant real = entry.getValue();

        writeEnchantmentsXml(type, real);
        ParseEnchants.reload();

        // Name resolution: the parser's id→name table must say what the facts say.
        assertEquals(real.name, ParseEnchants.ENCHANTS.get(type));

        // DPS math: a weapon code carrying this real enchant id must yield the
        // facts' multiplier through the real decode path.
        ParseEnchants.Totals totals =
            ParseEnchants.computeWeaponMultipliers(weaponCode(type));
        assertEquals(real.minDamageMult, totals.minDamage, 1e-4);
        if (real.maxDamageMult != null) {
            assertEquals(real.maxDamageMult, totals.maxDamage, 1e-4);
        }
        assertTrue("a damage enchant must not default to 1x min damage",
            Math.abs(totals.minDamage - 1f) > 1e-6);
    }

    /**
     * The verified real structure: id/type are attributes, mutator values are
     * element text (with the projectileId attribute real assets carry). Values
     * are the FACTS' values - nothing invented.
     */
    private static void writeEnchantmentsXml(short type, AssetFacts.Enchant real) throws IOException {
        XML_FILE.getParentFile().mkdirs();
        StringBuilder mutators = new StringBuilder();
        if (real.minDamageMult != null) {
            mutators.append("      <MultiplyMinDamage projectileId=\"-1\">")
                .append(real.minDamageMult).append("</MultiplyMinDamage>\n");
        }
        if (real.maxDamageMult != null) {
            mutators.append("      <MultiplyMaxDamage projectileId=\"-1\">")
                .append(real.maxDamageMult).append("</MultiplyMaxDamage>\n");
        }
        if (real.rateOfFireMult != null) {
            mutators.append("      <MultiplyRateOfFire projectileId=\"-1\">")
                .append(real.rateOfFireMult).append("</MultiplyRateOfFire>\n");
        }
        String xml = "<Enchantments>\n"
            + "  <Enchantment id=\"" + real.name + "\" type=\"0x" + Integer.toHexString(type) + "\">\n"
            + "    <Mutators>\n" + mutators + "    </Mutators>\n"
            + "  </Enchantment>\n"
            + "</Enchantments>\n";
        Files.write(XML_FILE.toPath(), xml.getBytes(StandardCharsets.UTF_8));
    }

    /** A UNIQUE_DATA_STRING weapon code carrying exactly this enchant id (same layout {@code encodeEnchantSlot} builds). */
    private static String weaponCode(short enchantId) {
        ByteBuffer buf = ByteBuffer.allocate(1 + 2 + 2 + 2).order(ByteOrder.LITTLE_ENDIAN);
        buf.put((byte) 0);          // header byte, unused by the decoder
        buf.putShort((short) 1026); // enchant-block type marker
        buf.putShort(enchantId);
        buf.putShort((short) -3);   // terminator
        return PcStatsDecoder.bytesToSixBitString(buf.array());
    }
}
