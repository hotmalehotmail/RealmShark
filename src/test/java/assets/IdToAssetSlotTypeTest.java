package assets;

import static org.junit.Assert.assertEquals;

import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for issue #217: the runtime {@code IdToAsset} never parsed
 * an item's own {@code <SlotType>} (the equipment-category enum, e.g.
 * objectType 283 "The Hive Key" -&gt; 10 per the committed
 * {@code asset-facts.json}) - it only read the same XML tag for a weapon's
 * projectile-group data ({@link IdToAsset#getIdProjectileSlotType}). This
 * covers the new dedicated {@link IdToAsset#getSlotType} accessor.
 */
public class IdToAssetSlotTypeTest {

    @Before
    public void hermeticFakes() {
        IdToAsset.clearFakeEntries();
    }

    @Test
    public void getSlotTypeReturnsTheRegisteredValue() {
        IdToAsset.registerFake(81201, "Equipment", 7, 10, "", "", "The Hive Key", "");

        assertEquals(10, IdToAsset.getSlotType(81201));
    }

    @Test
    public void getSlotTypeDefaultsToZeroWhenNotRegistered() {
        IdToAsset.registerFake(81202, "Equipment", 6);

        assertEquals(0, IdToAsset.getSlotType(81202));
    }

    @Test
    public void getSlotTypeIsZeroForAnUnknownId() {
        assertEquals(0, IdToAsset.getSlotType(999998));
    }

    @Test
    public void slotTypeIsIndependentOfProjectileSlotType() {
        // A weapon carries its own (unrelated) projectile-group slot via the
        // Projectile-string prefix, exercised elsewhere - getSlotType must
        // resolve strictly from the dedicated ObjectID.list column, not that
        // projectile data (which registerFake never populates, so a mixed-up
        // implementation would read 0 for both, masking the bug this test
        // guards against on the ObjectID.list-parsing path).
        IdToAsset.registerFake(81203, "Equipment", 6, 15, "", "", "Fake Wand of Testing", "");

        assertEquals(15, IdToAsset.getSlotType(81203));
        assertEquals(0, IdToAsset.getIdProjectileSlotType(81203));
    }
}
