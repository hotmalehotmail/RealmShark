package bridge.dps;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import java.util.List;
import org.junit.Test;

/**
 * Covers the enchant-count derivation issue #107's rarity borders are built
 * on: {@link ParseEnchants#extractEnchantIds} must recover exactly the number
 * of filled enchant slots that {@link ParseEnchants#encodeEnchantSlot} (the
 * FakePacketSource/test fixture helper) encoded, for every count 0-4 an item
 * can carry. This is what makes the `--fake` rarity-border demo trustworthy -
 * if this round-trip ever breaks, FakePacketSource would be emitting enchant
 * data the overlay (or a live client) can't decode correctly.
 */
public class ParseEnchantsRarityTest {

    @Test
    public void roundTripsZeroToFourFilledEnchantSlots() {
        for (int count = 0; count <= 4; count++) {
            String code = ParseEnchants.encodeEnchantSlot(count);
            List<Short> ids = ParseEnchants.extractEnchantIds(code);
            assertEquals("count=" + count, count, ids.size());
        }
    }

    @Test
    public void emptyOrNullCodeHasNoEnchants() {
        assertTrue(ParseEnchants.extractEnchantIds("").isEmpty());
        assertTrue(ParseEnchants.extractEnchantIds(null).isEmpty());
    }

    @Test
    public void getEnchantStringsSplitsFourSlotsFromEncodedUniqueDataString() {
        // Mirrors FakePacketSource.enchantUniqueDataString's comma-joined shape.
        String uniqueDataString = String.join(
            ",",
            ParseEnchants.encodeEnchantSlot(1),
            ParseEnchants.encodeEnchantSlot(2),
            ParseEnchants.encodeEnchantSlot(3),
            ParseEnchants.encodeEnchantSlot(4)
        );
        String[] slots = uniqueDataString.split(",");
        assertEquals(4, slots.length);
        assertEquals(1, ParseEnchants.extractEnchantIds(slots[0]).size());
        assertEquals(2, ParseEnchants.extractEnchantIds(slots[1]).size());
        assertEquals(3, ParseEnchants.extractEnchantIds(slots[2]).size());
        assertEquals(4, ParseEnchants.extractEnchantIds(slots[3]).size());
    }
}
