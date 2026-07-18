package assets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for the alpha-soak bug (issue soak #215): the Loot panel's
 * shiny-item badge never displayed on real assets. It was derived client-side
 * from {@link IdToAsset#objectName}'s resolved display name, but that method
 * prefers a shiny item's {@code displayId} (the shared, suffix-stripped base
 * name it carries on real assets - confirmed via {@code AssetExtractor}'s
 * {@code DisplayId} parsing) over its raw {@code " Shiny"}-suffixed id
 * whenever a {@code displayId} is set, which real assets do for nearly every
 * shiny item. {@link IdToAsset#isShiny} checks the raw id directly, so it
 * stays correct regardless of what {@code objectName} resolves to.
 */
public class IdToAssetShinyTest {

    @Before
    public void hermeticFakes() {
        IdToAsset.clearFakeEntries();
    }

    @Test
    public void isShinyIsTrueWhenTheRawIdCarriesTheSuffixEvenWithADisplayName() {
        IdToAsset.registerFake(81101, "Equipment", 6, "", "Dirk of Cronus Shiny", "Dirk of Cronus", "");

        assertTrue(IdToAsset.isShiny(81101));
        // The resolved display name is the shared, suffix-stripped name - the
        // exact case that broke name-based shininess detection.
        assertEquals("Dirk of Cronus", IdToAsset.objectName(81101));
    }

    @Test
    public void isShinyIsFalseForAPlainItemWithNoSuffix() {
        IdToAsset.registerFake(81102, "Equipment", 6, "", "Potion of Life", "Potion of Life", "");

        assertFalse(IdToAsset.isShiny(81102));
    }

    @Test
    public void isShinyIsFalseForAnUnknownId() {
        assertFalse(IdToAsset.isShiny(999999));
    }
}
