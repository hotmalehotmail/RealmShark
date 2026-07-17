package assets.facts;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * CI's ground-truth check (issue #189, PRD §7.4): the committed
 * {@code asset-facts.json} - distilled from a REAL game dump by
 * {@link AssetFactsExtractor} - must keep carrying the real-asset facts the
 * code depends on. These assertions encode what the loot saga (soaks
 * #113/#144) had to discover the hard way, so a facts refresh (per game
 * update) that loses any of them fails here instead of in a live soak.
 */
public class AssetFactsBundledTest {

    private static AssetFacts facts() {
        AssetFacts facts = AssetFacts.loadBundled();
        assertNotNull("committed asset-facts.json must be on the classpath", facts);
        return facts;
    }

    @Test
    public void carriesProvenanceFields() {
        AssetFacts facts = facts();
        assertNotNull(facts.gameBuild);
        assertNotNull(facts.extractedAt);
        assertNotNull(facts.sourceHash);
        assertTrue(facts.generator.startsWith("AssetFactsExtractor"));
    }

    @Test
    public void trackedBagEntitiesMatchTheVerifiedLiveIds() {
        AssetFacts facts = facts();
        // The ids the KNOWN_BAG_ICON_IDS fallback (verified live, soak #113)
        // hardcodes must be exactly what the real assets say: white = "Loot
        // Bag 6" = 1292, orange = "Loot Bag 8" = 1295.
        AssetFacts.Entity white = facts.entities.get("1292");
        assertEquals("Loot Bag 6", white.name);
        assertEquals(6, white.bagType);
        assertFalse(white.boosted);
        AssetFacts.Entity orange = facts.entities.get("1295");
        assertEquals("Loot Bag 8", orange.name);
        assertEquals(8, orange.bagType);
        assertFalse(orange.boosted);
    }

    @Test
    public void boostedTrackedVariantsExistAndAreFlagged() {
        AssetFacts facts = facts();
        // The divergence issue #189 surfaced: boosted white/orange bags are
        // real, distinct objectTypes - the pre-facts pipeline never recognized
        // them, so a boosted drop was invisible to the overlay's drop tracker.
        AssetFacts.Entity boostedWhite = facts.entities.get("1296");
        assertEquals(6, boostedWhite.bagType);
        assertTrue(boostedWhite.boosted);
        AssetFacts.Entity boostedOrange = facts.entities.get("1727");
        assertEquals(8, boostedOrange.bagType);
        assertTrue(boostedOrange.boosted);
    }

    @Test
    public void noBagEntityIsClassBag() {
        // The loot saga's root cause, pinned forever: real ground-bag entities
        // are Class=Container - a Class=Bag scan matches nothing.
        facts().entities.values().forEach(e -> {
            assertEquals(e.name + " must be Class=Container", "Container", e.clazz);
        });
    }

    @Test
    public void itemCorpusIsRealSized() {
        AssetFacts facts = facts();
        long white = facts.items.values().stream().filter(i -> i.bagType == 6).count();
        long orange = facts.items.values().stream().filter(i -> i.bagType == 8).count();
        // Real assets carry hundreds of each; a facts file with a handful
        // means the extractor ran against a partial/synthetic dump.
        assertTrue("expected 100+ white-bag items, got " + white, white >= 100);
        assertTrue("expected 100+ orange-bag items, got " + orange, orange >= 100);
    }

    @Test
    public void wizardCarriesRealStatMaximaAndStartingWeapon() {
        AssetFacts.PlayerClass wizard = facts().classes.values().stream()
            .filter(c -> "Wizard".equals(c.name))
            .findFirst()
            .orElseThrow(() -> new AssertionError("Wizard class missing from facts"));
        assertEquals(8, wizard.maxStats.size());
        assertTrue("wizard max life should be several hundred", wizard.maxStats.get("life") >= 500);
        assertTrue("starting weapon (first Equipment id) must exist", wizard.equipment.length > 0);
    }

    @Test
    public void enchantsCarryReadableNamesAndDpsMutators() {
        AssetFacts facts = facts();
        assertTrue("expected a real-sized enchant table", facts.enchants.size() >= 100);
        // Soak #113's ask: enchant ids must resolve to readable text.
        assertTrue(facts.enchants.values().stream().anyMatch(e -> e.displayId != null));
        // And ParseEnchants' DPS math needs damage mutators to exist somewhere.
        assertTrue(facts.enchants.values().stream().anyMatch(e -> e.minDamageMult != null));
    }
}
