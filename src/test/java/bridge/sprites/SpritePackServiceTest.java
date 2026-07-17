package bridge.sprites;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import com.google.gson.JsonObject;
import org.junit.Test;

/**
 * Covers the graceful-degradation the {@code uiSprites} pack section must
 * guarantee (issue #205, docs/asset-pipeline.md): headless CI/dev has never
 * run a real extraction, so {@code assets/sprites/ui/*.png} doesn't exist -
 * the section must come back empty, never throw.
 */
public class SpritePackServiceTest {

    @Test
    public void uiSpritesIsEmptyWithNoExtractedAssets() {
        JsonObject uiSprites = new SpritePackService().buildUiSprites();
        assertNotNull(uiSprites);
        assertEquals(0, uiSprites.size());
    }
}
