package assets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.util.Arrays;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Issue #211: the extraction freshness gate keyed only on the game file's
 * mtime, so a bridge upgrade whose extractor gained a NEW output (#207's
 * {@code assets/sprites/ui/}) skipped extraction forever on a warm cache and
 * the output was never generated. The gate now presence-checks every declared
 * extractor output ({@link AssetExtractor#EXTRACTOR_OUTPUT_MARKERS}); these
 * tests pin the presence logic and the declaration itself.
 */
public class AssetExtractorFreshnessTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private void createAllMarkers() throws Exception {
        for (String marker : AssetExtractor.EXTRACTOR_OUTPUT_MARKERS) {
            File f = new File(tmp.getRoot(), marker);
            if (marker.endsWith(".list")) {
                f.getParentFile().mkdirs();
                assertTrue(f.createNewFile());
            } else {
                assertTrue(f.mkdirs() || f.isDirectory());
            }
        }
    }

    @Test
    public void upToDateWhenEveryDeclaredOutputExists() throws Exception {
        createAllMarkers();
        assertNull(AssetExtractor.firstMissingOutputMarker(tmp.getRoot()));
    }

    /** The exact #211 scenario: warm pre-#207 cache, no ui/ dir - must read as stale. */
    @Test
    public void staleWhenTheUiSpritesOutputIsMissing() throws Exception {
        createAllMarkers();
        assertTrue(new File(tmp.getRoot(), "assets/sprites/ui").delete());
        assertEquals(
            "assets/sprites/ui",
            AssetExtractor.firstMissingOutputMarker(tmp.getRoot())
        );
    }

    @Test
    public void staleWhenALegacyListOutputIsMissing() throws Exception {
        createAllMarkers();
        assertTrue(new File(tmp.getRoot(), AssetExtractor.ASSETS_OBJECT_FILE_DIR_PATH).delete());
        assertEquals(
            AssetExtractor.ASSETS_OBJECT_FILE_DIR_PATH,
            AssetExtractor.firstMissingOutputMarker(tmp.getRoot())
        );
    }

    @Test
    public void emptyDirCountsAsPresent_bestEffortAttemptMarkerContract() throws Exception {
        // An EMPTY ui/ dir means "this extractor version attempted UI sprites,
        // the game build had none" (UnityExtractor creates it before its
        // availability guards) - it must NOT read as stale, or such installs
        // would re-extract on every launch.
        createAllMarkers();
        assertNull(AssetExtractor.firstMissingOutputMarker(tmp.getRoot()));
    }

    /** Pins the declaration: removing a marker (or forgetting #211's ui entry) is a red test, not a silent regression. */
    @Test
    public void declaredMarkersCoverTheKnownOutputs() {
        assertTrue(Arrays.asList(AssetExtractor.EXTRACTOR_OUTPUT_MARKERS)
            .containsAll(Arrays.asList(
                AssetExtractor.ASSETS_OBJECT_FILE_DIR_PATH,
                AssetExtractor.ASSETS_TILE_FILE_DIR_PATH,
                "assets/sprites/ui"
            )));
    }
}
