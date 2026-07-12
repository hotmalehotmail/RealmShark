package bridge.dps;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for the alpha-soak bug (issue soak #113): {@code
 * ParseEnchants} reads assets/xml/enchantments.xml in a static initializer
 * that races the bridge's async asset-extraction thread ({@code
 * ObjectNames.init}) - {@code EnchantNames.envelopeJson()} broadcasts every
 * 2s starting almost immediately, well before extraction (which reads the
 * whole game's resources.assets) typically finishes on a real machine, so
 * {@link ParseEnchants#ENCHANTS} stayed permanently at just its built-in
 * {@code -1} entry and the item tooltip fell back to the bare enchant id for
 * every real enchantment. {@link ParseEnchants#reload} lets a caller retry
 * once extraction has actually finished, mirroring {@code
 * CharacterClassTest}'s coverage of the identical race on players.xml.
 */
public class ParseEnchantsReloadTest {

    private static final File XML_FILE = new File("assets/xml/enchantments.xml");
    private static final short TEST_ENCHANT_ID = 0x3039; // 12345

    @Before
    public void removeEnchantmentsXml() throws IOException {
        Files.deleteIfExists(XML_FILE.toPath());
    }

    @After
    public void cleanup() throws IOException {
        Files.deleteIfExists(XML_FILE.toPath());
    }

    @Test
    public void reloadRecoversAfterAssetsAppearLate() throws IOException {
        // Simulate the race: reload() runs before extraction wrote the file,
        // same as the static initializer racing the extraction thread.
        ParseEnchants.reload();
        assertNull(ParseEnchants.ENCHANTS.get(TEST_ENCHANT_ID));

        writeEnchantmentsXml();

        // Simulate ObjectNames.init calling reload() once extraction finished.
        ParseEnchants.reload();
        assertEquals("Test Enchant", ParseEnchants.ENCHANTS.get(TEST_ENCHANT_ID));
    }

    private static void writeEnchantmentsXml() throws IOException {
        XML_FILE.getParentFile().mkdirs();
        String xml = "<Enchantments>\n" +
            "  <Enchantment id=\"Test Enchant\" type=\"0x3039\"/>\n" +
            "</Enchantments>\n";
        Files.write(XML_FILE.toPath(), xml.getBytes());
    }
}
