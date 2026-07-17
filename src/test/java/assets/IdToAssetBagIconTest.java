package assets;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Before;
import org.junit.Test;

/**
 * Regression test for the alpha-soak bug (issue soak #113): the Loot panel's
 * white/orange bag category-header sprite rendered as an empty box for every
 * bag color. {@link IdToAsset#findBagIconObjectType} resolves the ground-bag
 * entity for a BagType in three tiers (issue #189): the real assets' id-name
 * rule ({@code "Loot Bag <N>[ Boost]"} where N IS the BagType, class
 * {@code Container} - discovered from the actual game XML, and the only rule
 * live assets satisfy), then the legacy {@code Class=Bag}+BagType scan (never
 * matches on live assets - the soak-#113 discovery - but kept for pre-facts
 * synthetic entries), then a hardcoded live-verified fallback table (white =
 * 1292, orange = 1295, matching upstream Tomato's {@code LootBags} enum) used
 * only when that id is actually a loaded object.
 */
public class IdToAssetBagIconTest {

    @Before
    public void hermeticFakes() {
        // registerFake entries are process-wide and permanent; drop them so
        // this class's precedence assertions can't be flipped by whichever
        // test class happened to run first in the shared JVM.
        IdToAsset.clearFakeEntries();
    }

    @Test
    public void fallsBackToKnownIdWhenNoScanMatches() {
        // BagType 8's known ground-bag id (1295) loaded as a plain object -
        // no rule-matching name, not flagged Class=Bag - simulating a
        // pre-facts build's real-client scan miss.
        IdToAsset.registerFake(1295, "Equipment", 0);
        assertEquals(Integer.valueOf(1295), IdToAsset.findBagIconObjectType(8));
    }

    @Test
    public void idNameRuleOutranksClassBagScanAndFallback() {
        // A real-named bag entity (Container, BagType only in the id string -
        // how live assets actually encode it) at a non-fallback id, plus a
        // legacy Class=Bag entry: the name rule must win.
        IdToAsset.registerFake(1292, "Equipment", 0);
        IdToAsset.registerFake(70001, "Bag", 6);
        IdToAsset.registerFakeNamed(70002, "Loot Bag 6", "Container", -1);
        assertEquals(Integer.valueOf(70002), IdToAsset.findBagIconObjectType(6));
    }

    @Test
    public void nonBoostedEntityIsTheCanonicalIconOverABoostedOne() {
        IdToAsset.registerFakeNamed(70003, "Loot Bag 6 Boost", "Container", -1);
        IdToAsset.registerFakeNamed(70004, "Loot Bag 6", "Container", -1);
        assertEquals(Integer.valueOf(70004), IdToAsset.findBagIconObjectType(6));
    }

    @Test
    public void boostedEntityStillResolvesWhenItIsTheOnlyOne() {
        IdToAsset.registerFakeNamed(70005, "Loot Bag 8 Boost", "Container", -1);
        assertEquals(Integer.valueOf(70005), IdToAsset.findBagIconObjectType(8));
    }

    @Test
    public void legacyClassBagScanStillOutranksTheFallback() {
        IdToAsset.registerFake(1292, "Equipment", 0);
        IdToAsset.registerFake(70006, "Bag", 6);
        assertEquals(Integer.valueOf(70006), IdToAsset.findBagIconObjectType(6));
    }

    @Test
    public void returnsNullWhenNothingResolves() {
        // BagType 42 has no known fallback and no registered entity of any kind.
        assertNull(IdToAsset.findBagIconObjectType(42));
    }
}
