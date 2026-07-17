package assets.resextractor;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;

/**
 * Reads raw RGBA32 pixel bytes directly out of the GUI Atlas's backing
 * {@code .resS} resource stream. The atlas's Texture2D record carries empty
 * StreamingInfo (no offset/size/path pointer to its own pixels) - one of 22
 * such "orphan" textures in the game's asset file - so the pixels can't be
 * resolved through any Unity metadata. They are known (issue #205, verified
 * against a real install) to sit at byte offset 0 of {@code
 * resources.assets.resS}, found by elimination as the single large unclaimed
 * region in that file. This is the fragile half of the UI-sprite pipeline: a
 * future game repack could move them, and there is no metadata-driven
 * fallback - only the length + non-zero-alpha sanity check below guards it.
 */
public class GuiAtlasPixels {
    private static final int CHANNELS = 4;

    private final File resS;
    private final int width;
    private final int height;

    public GuiAtlasPixels(File resourcesAssetsFile, int width, int height) {
        this.resS = new File(resourcesAssetsFile.getPath() + ".resS");
        this.width = width;
        this.height = height;
    }

    /** True when the sibling .resS file exists and is large enough to hold one atlas mip. */
    public boolean isAvailable() {
        return resS.isFile() && resS.length() >= (long) width * height * CHANNELS;
    }

    /**
     * Crops {@code (x, y, w, h)} - Unity texture coordinates, origin
     * bottom-left, exactly as stored in a {@link SpriteAtlas.RenderDataMap}'s
     * textureRect - to a top-left-origin RGBA byte array (row-major, top row
     * first), reading only the rows the rect touches.
     */
    public byte[] crop(int x, int y, int w, int h) throws IOException {
        byte[] out = new byte[w * h * CHANNELS];
        try (RandomAccessFile raf = new RandomAccessFile(resS, "r")) {
            for (int row = 0; row < h; row++) {
                int sourceRow = y + (h - 1 - row); // Unity rows are bottom-up
                long offset = ((long) sourceRow * width + x) * CHANNELS;
                raf.seek(offset);
                raf.readFully(out, row * w * CHANNELS, w * CHANNELS);
            }
        }
        return out;
    }

    /** Sanity check: a real crop has at least one non-zero alpha byte. */
    public static boolean looksValid(byte[] rgba) {
        for (int i = CHANNELS - 1; i < rgba.length; i += CHANNELS) {
            if (rgba[i] != 0) return true;
        }
        return false;
    }
}
