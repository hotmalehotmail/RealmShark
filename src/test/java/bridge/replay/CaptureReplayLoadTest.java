package bridge.replay;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import org.junit.Test;

/**
 * Verifies {@link CaptureReplay#loadCapture} against every committed capture shape - the Java
 * mirror of {@code loadCapture} in {@code overlay/test/replay.ts} must accept the same fixture
 * files that harness already reads (see {@code overlay/test/fixtures/captures/README.md}).
 */
public class CaptureReplayLoadTest {

    private static Path capture(String name) {
        return Paths.get("overlay", "test", "fixtures", "captures", name);
    }

    @Test
    public void loadsBugReportJsonShape() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes =
            CaptureReplay.loadCapture(capture("soak-122-equip-unequip.json.gz"));
        assertEquals(300, envelopes.size());
        assertSortedByTime(envelopes);
    }

    @Test
    public void loadsNdjsonSessionRecordingShape() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes =
            CaptureReplay.loadCapture(capture("session-recording-sample.ndjson.gz"));
        assertEquals(3, envelopes.size());
        assertEquals("MapInfoPacket", envelopes.get(0).type);
        assertSortedByTime(envelopes);
    }

    @Test
    public void loadsLargeNdjsonBaselineShape() throws IOException {
        List<CaptureReplay.PacketEnvelope> envelopes =
            CaptureReplay.loadCapture(capture("baseline-session.ndjson.gz"));
        assertTrue(envelopes.size() > 20_000);
        assertSortedByTime(envelopes);
    }

    @Test
    public void detectsGzipByMagicBytesWithoutGzExtension() throws IOException {
        Path renamed = Files.createTempFile("replay-fixture", ".json");
        renamed.toFile().deleteOnExit();
        Files.write(renamed, Files.readAllBytes(capture("soak-122-equip-unequip.json.gz")));

        List<CaptureReplay.PacketEnvelope> envelopes = CaptureReplay.loadCapture(renamed);
        assertEquals(300, envelopes.size());
    }

    private static void assertSortedByTime(List<CaptureReplay.PacketEnvelope> envelopes) {
        for (int i = 1; i < envelopes.size(); i++) {
            assertTrue("envelopes must be sorted by time ascending",
                envelopes.get(i).time >= envelopes.get(i - 1).time);
        }
    }
}
