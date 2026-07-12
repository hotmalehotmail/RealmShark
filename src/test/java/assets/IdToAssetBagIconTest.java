package assets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/**
 * Regression test for the alpha-soak bug (issue soak #113): the Loot panel's
 * white/orange bag category-header sprite rendered as an empty box for every
 * bag color. {@link IdToAsset#findBagIconObjectType} derives the ground-bag
 * entity's objectType by scanning loaded assets for a {@code Class=Bag} entry
 * whose own BagType matches - soak testing against the real client showed
 * that scan alone finds nothing (the ground-bag entity's XML doesn't
 * reliably self-report a matching {@code Class=Bag}+{@code BagType} pair the
 * way an item's own BagType does), leaving {@code lootBagIcons} empty. A
 * hardcoded fallback table (verified against the live game, matching
 * upstream Tomato's {@code LootBags} enum: white=1292, orange=1295) now
 * covers that gap - used only when the XML-derived scan finds nothing, and
 * only when that id is actually a loaded object.
 */
public class IdToAssetBagIconTest {

    @Test
    public void fallsBackToKnownIdWhenXmlScanFindsNothing() {
        // BagType 8's known ground-bag id (1295) loaded as a plain object -
        // not flagged Class=Bag - simulating the real-client scan miss.
        IdToAsset.registerFake(1295, "Equipment", 0);
        assertEquals(Integer.valueOf(1295), IdToAsset.findBagIconObjectType(8));
    }

    @Test
    public void prefersXmlDerivedBagEntityOverKnownFallback() {
        // A real Class=Bag entry for BagType 6 at a different id than the
        // known fallback (1292) - the scan should take priority.
        IdToAsset.registerFake(1292, "Equipment", 0);
        IdToAsset.registerFake(70001, "Bag", 6);
        assertEquals(Integer.valueOf(70001), IdToAsset.findBagIconObjectType(6));
    }

    @Test
    public void returnsNullWhenNeitherXmlNorKnownIdIsLoaded() {
        // BagType 42 has no known fallback and no registered Class=Bag entry.
        assertNull(IdToAsset.findBagIconObjectType(42));
    }
}
