package bridge.dps.enums;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for the alpha-soak bug (issue #50): CharacterClass reads
 * assets/xml/players.xml in a static initializer that races the bridge's
 * async asset-extraction thread (ObjectNames.init). When extraction hasn't
 * written the file yet by the time the static block runs, the lookup tables
 * stay permanently empty for the rest of the process - every entity looks
 * unclassified, so other players never get added to DpsEngine's playerList
 * and their damage never gets attributed. CharacterClass#reload lets a
 * caller retry once extraction has actually finished.
 */
public class CharacterClassTest {

    private static final File XML_FILE = new File("assets/xml/players.xml");
    private static final int WIZARD_TYPE = 0x0300;

    @Before
    public void removePlayersXml() throws IOException {
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
        CharacterClass.reload();
        assertFalse(CharacterClass.isPlayerCharacter(WIZARD_TYPE));

        writePlayersXml();

        // Simulate ObjectNames.init calling reload() once extraction finished.
        CharacterClass.reload();
        assertTrue(CharacterClass.isPlayerCharacter(WIZARD_TYPE));
    }

    private static void writePlayersXml() throws IOException {
        XML_FILE.getParentFile().mkdirs();
        String xml = "<Objects>\n" +
            "  <Object type=\"0x0300\" id=\"Wizard\">\n" +
            "    <MaxHitPoints max=\"100\"/>\n" +
            "    <MaxMagicPoints max=\"100\"/>\n" +
            "    <Attack max=\"1\"/>\n" +
            "    <Defense max=\"1\"/>\n" +
            "    <Speed max=\"1\"/>\n" +
            "    <Dexterity max=\"1\"/>\n" +
            "    <HpRegen max=\"1\"/>\n" +
            "    <MpRegen max=\"1\"/>\n" +
            "    <Equipment>0x0100, 0x0101, 0x0102, 0xffff</Equipment>\n" +
            "  </Object>\n" +
            "</Objects>\n";
        Files.write(XML_FILE.toPath(), xml.getBytes());
    }
}
