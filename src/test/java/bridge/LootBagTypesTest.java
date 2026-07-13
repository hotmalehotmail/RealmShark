package bridge;

import static org.junit.Assert.assertEquals;

import assets.IdToAsset;
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

    @Test
    public void lootBagObjectTypesFallsBackToKnownIdsWhenXmlScanFindsNothing() {
        // Known fallback ids (see IdToAsset.KNOWN_BAG_ICON_IDS: white=1292,
        // orange=1295) loaded as plain objects with no matching Class=Bag +
        // BagType - simulating the real client's ground-bag XML gap.
        IdToAsset.registerFake(1292, "Equipment", 0);
        IdToAsset.registerFake(1295, "Equipment", 0);

        JsonObject data = JsonParser.parseString(new LootBagTypes().envelopeJson())
            .getAsJsonObject()
            .getAsJsonObject("data");
        JsonObject objectTypes = data.getAsJsonObject("lootBagObjectTypes");

        assertEquals(6, objectTypes.get("1292").getAsInt());
        assertEquals(8, objectTypes.get("1295").getAsInt());
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
}
