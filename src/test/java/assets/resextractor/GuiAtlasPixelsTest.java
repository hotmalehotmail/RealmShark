package assets.resextractor;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import org.junit.Test;

/**
 * Covers the fragile part of the GUI-atlas UI-sprite pipeline (issue #205,
 * docs/asset-pipeline.md): the raw {@code .resS} pixel read and the
 * Unity-bottom-up-to-top-left row flip. No real game install exists in CI,
 * so this exercises the crop arithmetic against a small synthetic atlas
 * instead of real asset bytes.
 */
public class GuiAtlasPixelsTest {

    @Test
    public void isAvailableFalseWhenResSMissing() {
        GuiAtlasPixels pixels = new GuiAtlasPixels(
            new File("/definitely/not/a/real/resources.assets"), 4096, 2048);
        assertFalse(pixels.isAvailable());
    }

    @Test
    public void cropFlipsUnityBottomUpRowsToTopDown() throws IOException {
        // A tiny 2x3 synthetic atlas (width=2, height=3): each pixel's R/G
        // bytes are tagged with its Unity (bottom-up) row/col, so a correct
        // crop must return the row tagged (height - 1) first.
        int width = 2, height = 3;
        File resourcesAssets = File.createTempFile("resources", ".assets");
        resourcesAssets.deleteOnExit();
        File resS = new File(resourcesAssets.getPath() + ".resS");
        resS.deleteOnExit();

        byte[] raw = new byte[width * height * 4];
        for (int row = 0; row < height; row++) {
            for (int col = 0; col < width; col++) {
                int idx = (row * width + col) * 4;
                raw[idx] = (byte) row;      // R tag = Unity row
                raw[idx + 1] = (byte) col;  // G tag = column
                raw[idx + 2] = 0;
                raw[idx + 3] = (byte) 0xFF; // non-zero alpha
            }
        }
        try (RandomAccessFile out = new RandomAccessFile(resS, "rw")) {
            out.write(raw);
        }

        GuiAtlasPixels pixels = new GuiAtlasPixels(resourcesAssets, width, height);
        assertTrue(pixels.isAvailable());

        byte[] cropped = pixels.crop(0, 0, width, height);
        assertTrue(GuiAtlasPixels.looksValid(cropped));
        // Output row 0 (top) must be Unity's topmost source row (height - 1).
        assertEquals((byte) (height - 1), cropped[0]);
        // Output last row must be Unity's bottom source row (row 0).
        int lastRowStart = (height - 1) * width * 4;
        assertEquals((byte) 0, cropped[lastRowStart]);
    }

    @Test
    public void looksValidFalseForAllZeroAlpha() {
        byte[] rgba = new byte[16]; // all zero, including alpha bytes
        assertFalse(GuiAtlasPixels.looksValid(rgba));
    }
}
