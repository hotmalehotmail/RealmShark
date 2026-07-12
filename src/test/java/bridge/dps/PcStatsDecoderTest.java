package bridge.dps;

import static org.junit.Assert.assertArrayEquals;

import java.util.Random;
import org.junit.Test;

/**
 * Round-trip coverage for the six-bit (base64url-like) string codec used by
 * UNIQUE_DATA_STRING (and other packed stat strings). {@link
 * PcStatsDecoder#bytesToSixBitString} was added as the inverse of the
 * pre-existing {@link PcStatsDecoder#sixBitStringToBytes} specifically so
 * FakePacketSource can synthesize valid enchant data (issue #107) - this test
 * proves the pair is actually symmetric across every padding case (byte
 * lengths not divisible by 3).
 */
public class PcStatsDecoderTest {

    @Test
    public void roundTripsArbitraryByteLengths() {
        Random rng = new Random(42);
        for (int len = 0; len <= 20; len++) {
            byte[] original = new byte[len];
            rng.nextBytes(original);

            String encoded = PcStatsDecoder.bytesToSixBitString(original);
            byte[] decoded = PcStatsDecoder.sixBitStringToBytes(encoded);

            assertArrayEquals("len=" + len, original, decoded);
        }
    }

    @Test
    public void emptyByteArrayRoundTrips() {
        String encoded = PcStatsDecoder.bytesToSixBitString(new byte[0]);
        assertArrayEquals(new byte[0], PcStatsDecoder.sixBitStringToBytes(encoded));
    }
}
