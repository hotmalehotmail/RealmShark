package assets.resextractor;

import static org.junit.Assert.assertTrue;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Test;

/**
 * Covers the graceful-degradation path {@code AssetProbe} must never violate:
 * no game installed (the CI/dev-sandbox default, per docs/asset-pipeline.md)
 * must produce a clear status message, never a crash. Also covers the
 * enchantments.xml tag scan (part 3 of the probe), the one section testable
 * without a real resources.assets file.
 */
public class AssetProbeTest {

    @Test
    public void runWithNullAssetsFileDoesNotThrowAndReportsStatus() {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AssetProbe.run(null, new PrintStream(buf, true, StandardCharsets.UTF_8));
        String report = buf.toString(StandardCharsets.UTF_8);
        assertTrue(report.contains("no resources.assets found"));
    }

    @Test
    public void runWithMissingPathDoesNotThrowAndReportsStatus() {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AssetProbe.run(
            new File("/definitely/not/a/real/resources.assets"),
            new PrintStream(buf, true, StandardCharsets.UTF_8)
        );
        String report = buf.toString(StandardCharsets.UTF_8);
        assertTrue(report.contains("no resources.assets found"));
    }

    @Test
    public void enchantmentsXmlMissingReportsNotFound() {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AssetProbe.probeEnchantmentsXml(
            new File("/definitely/not/a/real/enchantments.xml"),
            new PrintStream(buf, true, StandardCharsets.UTF_8)
        );
        String report = buf.toString(StandardCharsets.UTF_8);
        assertTrue(report.contains("NOT FOUND"));
    }

    @Test
    public void enchantmentsXmlFlagsUnparsedIconTag() throws IOException {
        File tmp = File.createTempFile("enchantments", ".xml");
        tmp.deleteOnExit();
        Files.write(
            tmp.toPath(),
            (
                "<Enchantments><Enchantment>"
                    + "<id>Test Enchant</id><type>0x100</type>"
                    + "<Icon>enchant_icon_1</Icon>"
                    + "<Mutators><MultiplyMinDamage><amount>1.1</amount></MultiplyMinDamage></Mutators>"
                    + "</Enchantment></Enchantments>"
            ).getBytes(StandardCharsets.UTF_8)
        );

        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        AssetProbe.probeEnchantmentsXml(tmp, new PrintStream(buf, true, StandardCharsets.UTF_8));
        String report = buf.toString(StandardCharsets.UTF_8);

        assertTrue(report.contains("TAG\tIcon"));
        assertTrue(report.contains("Icon"));
        assertTrue(report.contains("Tags NOT read by ParseEnchants.loadEnchants"));
    }
}
