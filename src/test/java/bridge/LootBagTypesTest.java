package bridge;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import assets.IdToAsset;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import org.junit.Test;

/**
 * Regression test for soak #144: the Loot panel's drop tracker never
 * recognized any white/orange ground-bag entity on real game assets, so the
 * panel stayed empty even after a correctly-BagType'd item dropped.
 * {@link LootBagTypes#envelopeJson()}'s {@code lootBagObjectTypes} builder
 * only trusted a scan for a {@code Class=Bag} entry whose own BagType
 * matches - but soak #113 already showed that scan finds nothing on real
 * assets (the ground-bag entity's XML doesn't reliably self-report a
 * matching {@code Class=Bag}+{@code BagType} pair, unlike an item's own
 * BagType). That soak only patched the icon lookup
 * ({@link IdToAsset#findBagIconObjectType}, see {@code
 * IdToAssetBagIconTest}) with a known-id fallback, leaving
 * {@code lootBagObjectTypes} - what the overlay's {@code LootTracker} keys
 * its bag-entity detection on - empty on real assets.
 */
public class LootBagTypesTest {

    @org.junit.Before
    public void hermeticFakes() {
        // registerFake entries are process-wide and permanent; start clean so
        // assertions here can't depend on which test class ran first.
        IdToAsset.clearFakeEntries();
    }

    /**
     * The facts-driven ground-truth test (issue #189): seed IdToAsset exactly
     * the way {@code FakePacketSource} now does - every tracked-color bag
     * entity from the committed {@code asset-facts.json}, registered with its
     * REAL id name and real class ({@code Container}, no self-reported
     * BagType, so the legacy {@code Class=Bag} scan sees nothing, just like
     * the live client) - and require the envelope's
     * {@code lootBagObjectTypes} to recognize ALL of them, boosted variants
     * included. Against the pre-#189 pipeline this fails for 1296/1727: only
     * the two fallback icon ids ever resolved, so a boosted white/orange bag
     * drop was invisible to the overlay's drop tracker.
     */
    @Test
    public void recognizesEveryRealTrackedBagEntityIncludingBoosted() {
        assets.facts.AssetFacts facts = assets.facts.AssetFacts.loadBundled();
        org.junit.Assert.assertNotNull("committed asset-facts.json missing", facts);
        facts.entities.forEach((key, entity) -> {
            if (entity.bagType != 6 && entity.bagType != 8) return;
            IdToAsset.registerFakeNamed(Integer.parseInt(key), entity.name, entity.clazz, -1);
        });

        JsonObject objectTypes = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data")
            .getAsJsonObject("lootBagObjectTypes");

        assertEquals(6, objectTypes.get("1292").getAsInt()); // Loot Bag 6 (white)
        assertEquals(6, objectTypes.get("1296").getAsInt()); // Loot Bag 6 Boost
        assertEquals(8, objectTypes.get("1295").getAsInt()); // Loot Bag 8 (orange)
        assertEquals(8, objectTypes.get("1727").getAsInt()); // Loot Bag 8 Boost
    }

    @Test
    public void lootBagObjectTypesIncludesResolvedIconEntityForEachTrackedColor() {
        // Known fallback ids (see IdToAsset.KNOWN_BAG_ICON_IDS: white=1292,
        // orange=1295) loaded as plain objects with no matching Class=Bag +
        // BagType - simulating the real client's ground-bag XML gap, so
        // findBagIconObjectType has at least this to resolve to for either
        // color even if no other test in this shared-state JVM has already
        // registered a genuine Class=Bag entity for it.
        //
        // Asserting against IdToAsset.findBagIconObjectType's own result
        // (rather than hardcoding which id "wins") is deliberate:
        // IdToAsset.registerFake entries are process-wide and never undone,
        // so another test class (e.g. IdToAssetBagIconTest) may have already
        // registered a real Class=Bag+BagType=6 entity earlier in this JVM,
        // in which case the scan legitimately outranks the known fallback for
        // that color - IdToAssetBagIconTest already covers that precedence.
        // This test's job is only to confirm LootBagTypes.envelopeJson()
        // actually folds findBagIconObjectType's resolution (soak #144),
        // whichever id that turns out to be.
        IdToAsset.registerFake(1292, "Equipment", 0);
        IdToAsset.registerFake(1295, "Equipment", 0);

        Integer expectedWhite = IdToAsset.findBagIconObjectType(6);
        Integer expectedOrange = IdToAsset.findBagIconObjectType(8);

        JsonObject data = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data");
        JsonObject objectTypes = data.getAsJsonObject("lootBagObjectTypes");

        assertEquals(6, objectTypes.get(String.valueOf(expectedWhite)).getAsInt());
        assertEquals(8, objectTypes.get(String.valueOf(expectedOrange)).getAsInt());
    }

    @Test
    public void prefersXmlDerivedBagEntityOverKnownFallback() {
        // A real Class=Bag entry for BagType 6 at a different id than the
        // known fallback (1292) - the scan-derived entity must still be kept
        // (not overwritten) alongside the fallback resolution.
        IdToAsset.registerFake(71001, "Bag", 6);

        JsonObject data = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data");
        JsonObject objectTypes = data.getAsJsonObject("lootBagObjectTypes");

        assertEquals(6, objectTypes.get("71001").getAsInt());
    }

    /**
     * Soak #215: an alpha shipped shininess detection derived client-side from
     * an item's resolved display name (`itemNames`). That silently never fires
     * on real assets, because {@link IdToAsset#objectName} prefers a shiny
     * item's {@code displayId} (the shared, suffix-stripped base name) over
     * its raw {@code " Shiny"}-suffixed id whenever a {@code displayId} is
     * set - true for nearly every real shiny item. This registers a fake
     * entry the same way (raw id name keeps the suffix, display name doesn't
     * - real assets' `AssetExtractor.parseChildObjects` populates `display`
     * from `<DisplayId>` the same way regardless of shininess) and requires
     * the envelope to flag it via the dedicated {@code shinyItemTypes} list,
     * NOT via its (suffix-stripped) {@code itemNames} entry.
     */
    @Test
    public void shinyItemTypesFlagsAShinyItemEvenWhenItsDisplayNameStripsTheSuffix() {
        IdToAsset.registerFake(
            81001, "Equipment", 6, "",
            "Dirk of Cronus Shiny", "Dirk of Cronus", ""
        );
        IdToAsset.registerFake(81002, "Equipment", 6, "", "Potion of Life", "Potion of Life", "");

        JsonObject data = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data");
        JsonObject itemNames = data.getAsJsonObject("itemNames");
        JsonArray shinyItemTypes = data.getAsJsonArray("shinyItemTypes");

        assertEquals("Dirk of Cronus", itemNames.get("81001").getAsString());
        assertTrue(shinyItemTypes.toString(), containsInt(shinyItemTypes, 81001));
        assertFalse(shinyItemTypes.toString(), containsInt(shinyItemTypes, 81002));
    }

    private static boolean containsInt(JsonArray array, int value) {
        for (int i = 0; i < array.size(); i++) {
            if (array.get(i).getAsInt() == value) return true;
        }
        return false;
    }

    /**
     * Issue #217: the envelope's item-carrying maps (bagTypeTable/itemNames/
     * lootBagObjectTypes) used to filter to BagType 6/8 at the source
     * ({@code bt != 6 && bt != 8}) - widened to cover every BagType present in
     * the loaded assets, so an item/bag entity of any other color (here 7,
     * the same color as the real "The Hive Key" fact) now shows up too.
     * {@code lootBagIcons} deliberately stays 6/8-only (the Loot panel's own
     * category-header colors), unaffected by this widening.
     */
    @Test
    public void bagTypeTableAndLootBagObjectTypesCoverANonTrackedColor() {
        IdToAsset.registerFake(82001, "Bag", 7);
        IdToAsset.registerFake(82002, "Equipment", 7, "", "Fake Hive Key", "Fake Hive Key", "");

        JsonObject data = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data");

        assertEquals(7, data.getAsJsonObject("lootBagObjectTypes").get("82001").getAsInt());
        assertEquals(7, data.getAsJsonObject("bagTypeTable").get("82002").getAsInt());
        assertEquals("Fake Hive Key", data.getAsJsonObject("itemNames").get("82002").getAsString());
        assertFalse(data.getAsJsonObject("lootBagIcons").has("7"));
    }

    /** Issue #217: an item's SlotType (the equipment-category enum) rides along in the new `slotTypes` map. */
    @Test
    public void slotTypesCarriesEachItemsSlotType() {
        IdToAsset.registerFake(82101, "Equipment", 7, 10, "", "", "Fake Hive Key", "");
        IdToAsset.registerFake(82102, "Equipment", 6, "", "Potion of Life", "Potion of Life", "");

        JsonObject slotTypes = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data")
            .getAsJsonObject("slotTypes");

        assertEquals(10, slotTypes.get("82101").getAsInt());
        assertEquals(0, slotTypes.get("82102").getAsInt());
    }
}
