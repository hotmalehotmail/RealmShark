package assets.resextractor;

import assets.AssetExtractor;
import assets.UiSpriteNames;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.AffineTransform;
import java.awt.geom.Rectangle2D;
import java.awt.image.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HashMap;
import java.util.Map;
import java.util.TreeSet;

/**
 * Class extracted from UnityPy https://github.com/K0lb3/UnityPy
 */
public class UnityExtractor {
    // Verified fallback for the GUI Atlas's dimensions (issue #205) - used
    // only if the backing Texture2D can't be found by name, in which case
    // its own m_Width/m_Height are read instead (no coordinates hardcoded).
    private static final int GUI_ATLAS_FALLBACK_WIDTH = 4096;
    private static final int GUI_ATLAS_FALLBACK_HEIGHT = 2048;
    private static final String GUI_ATLAS_NAME = "GUI Atlas";

    private int counter = 0;
    private TreeSet<String> checkDupes = new TreeSet<>();

    public void extract(File input, File[] output) throws IOException {
        AssetExtractor.setDisplay("Creating Folders");
        createFolders(output);

        Resources res = new Resources(input);

        AssetExtractor.setDisplay("Extracting Spritesheet File");
        extractSpritesheet(res, output[0]);
        AssetExtractor.setDisplay("Extracting Sprites");
        extractSprites(res, output[1]);
        AssetExtractor.setDisplay("Extracting Xml Files");
        extractXml(res, output[2]);
        AssetExtractor.setDisplay("Extracting UI Sprites");
        extractUiSprites(res, input, new File(output[1], "ui"));
    }

    private void createFolders(File[] output) {
        for (File f : output) {
            boolean b = f.mkdirs();

            try {
                File ff = new File(f + "/temp");
                ff.createNewFile();
                ff.delete();
            } catch (IOException e) {
                String s = e.getMessage();
                if (s.equals("The system cannot find the path specified")) {
                    JOptionPane.showMessageDialog(null, "<html>Extraction access denied, failed to extract!<br/>Please move Tomato to a different folder,<br/>Windows is blocking access in current folder.</html>\"");
                    System.exit(0);
                }
            }
        }
    }

    private void extractXml(Resources res, File outputFolder) {
        for (TextAsset t : res.assetTextAsset) {
            counter++;
            AssetExtractor.setDisplay("Extracting Xml Files " + counter);

            if (!Arrays.asList(TextAsset.NON_XML_FILES).contains(t.name)) {
                String name = checkDuplicates(t.name);
                File outputFile = new File(outputFolder + "/" + name + ".xml");
                try {
                    FileOutputStream outputStream = new FileOutputStream(outputFile);
                    outputStream.write(t.m_Script);
                    outputStream.close();
                } catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    private String checkDuplicates(String name) {
        String n = name;
        int count = 1;
        while (true) {
            if (!checkDupes.contains(n)) {
                checkDupes.add(n);
                return n;
            } else {
                count++;
                n = name + count;
            }
        }
    }

    private void extractSpritesheet(Resources res, File outputFolder) {
        if (res.spritesheet != null) {
            File outputFile = new File(outputFolder + "/spritesheetf");
            try (FileOutputStream outputStream = new FileOutputStream(outputFile)) {
                outputStream.write(res.spritesheet.m_Script);
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
    }

    private void extractSprites(Resources res, File outputFolder) {
        for (Texture2D t : res.assetTexture2D) {
            if (Arrays.asList(Texture2D.SPRITESHEET_NAMES).contains(t.name)) {
                AssetExtractor.setDisplay("Extracting Sprite: " + t.name);
                File outputFile = new File(outputFolder + "/" + t.name + ".png");
                int width = t.m_Width;
                int height = t.m_Height;
                byte[] data = t.image_data;

                DataBuffer buffer = new DataBufferByte(data, data.length);

                WritableRaster raster = Raster.createInterleavedRaster(buffer, width, height, 4 * width, 4, new int[]{0, 1, 2, 3}, null);
                ColorModel cm = new ComponentColorModel(ColorModel.getRGBdefault().getColorSpace(), true, true, Transparency.TRANSLUCENT, DataBuffer.TYPE_BYTE);
                BufferedImage image = new BufferedImage(cm, raster, true, null);

                AffineTransform at = new AffineTransform();
                at.concatenate(AffineTransform.getScaleInstance(1, -1));
                at.concatenate(AffineTransform.getTranslateInstance(0, -image.getHeight()));
                BufferedImage newImage = new BufferedImage(image.getWidth(), image.getHeight(), BufferedImage.TYPE_INT_ARGB);
                Graphics2D g = newImage.createGraphics();
                g.transform(at);
                g.drawImage(image, 0, 0, null);
                g.dispose();

                try {
                    ImageIO.write(newImage, "png", outputFile);
                } catch (IOException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    /**
     * Crops the allowlisted named UI sprites ({@link UiSpriteNames#ALLOWLIST})
     * out of the GUI Atlas and writes each as its own small PNG under
     * {@code outputFolder} (issue #205) - a generic channel the frontend can
     * grow without ever touching this pipeline again, since resolution is by
     * name, not by hardcoded coordinates. Best-effort like the rest of
     * extraction: any missing piece (no GUI Atlas, no .resS pixel data, a
     * name not present this game version) is silently skipped, never thrown.
     */
    private void extractUiSprites(Resources res, File input, File outputFolder) {
        try {
            // Create the output dir BEFORE any availability guard: its
            // presence is the freshness gate's "this extractor version
            // attempted UI sprites" marker
            // (AssetExtractor.EXTRACTOR_OUTPUT_MARKERS, issue #211). Created
            // even when the atlas/pixel data is unavailable this game build,
            // so a best-effort miss can't retrigger a full re-extraction on
            // every launch - an empty dir means "attempted, nothing found",
            // a missing dir means "this extractor never ran".
            outputFolder.mkdirs();
            SpriteAtlas guiAtlas = findAtlasByName(res, GUI_ATLAS_NAME);
            if (guiAtlas == null) return;

            int width = GUI_ATLAS_FALLBACK_WIDTH;
            int height = GUI_ATLAS_FALLBACK_HEIGHT;
            for (Texture2D t : res.assetTexture2D) {
                if (t.name != null && t.name.contains(GUI_ATLAS_NAME)) {
                    width = t.m_Width;
                    height = t.m_Height;
                    break;
                }
            }

            GuiAtlasPixels pixels = new GuiAtlasPixels(input, width, height);
            if (!pixels.isAvailable()) return;

            Map<String, Rectangle2D> rectsByName = joinSpriteNamesToRects(res, guiAtlas);
            for (String name : UiSpriteNames.ALLOWLIST) {
                Rectangle2D rect = rectsByName.get(name);
                if (rect == null) continue;
                AssetExtractor.setDisplay("Extracting UI Sprite: " + name);
                writeUiSpritePng(pixels, rect, new File(outputFolder, name + ".png"));
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }

    private SpriteAtlas findAtlasByName(Resources res, String name) {
        for (SpriteAtlas a : res.assetSpriteAtlas) {
            if (name.equals(a.name)) return a;
        }
        return null;
    }

    /**
     * Joins every parsed {@link Sprite}'s {@code m_RenderDataKey} to the
     * atlas's {@code m_RenderDataMap} entries (matched by the GUID+fileID
     * pair both sides carry) to resolve {@code name -> textureRect} for
     * every sprite the atlas packs - the mechanism that lets the allowlist
     * above be names only, with no coordinates in source.
     */
    private Map<String, Rectangle2D> joinSpriteNamesToRects(Resources res, SpriteAtlas atlas) {
        Map<String, Rectangle2D> rectsByKey = new HashMap<>();
        for (SpriteAtlas.RenderDataMap rdm : atlas.m_RenderDataMap) {
            rectsByKey.put(renderDataKey(rdm.first, rdm.second), rdm.textureRect);
        }
        Map<String, Rectangle2D> rectsByName = new HashMap<>();
        for (Sprite s : res.assetSprite) {
            Rectangle2D rect = rectsByKey.get(renderDataKey(s.renderDataKeyGuid, s.renderDataKeyFileId));
            if (rect != null) rectsByName.put(s.name, rect);
        }
        return rectsByName;
    }

    private String renderDataKey(byte[] guid, long fileId) {
        return Base64.getEncoder().encodeToString(guid) + "_" + fileId;
    }

    private void writeUiSpritePng(GuiAtlasPixels pixels, Rectangle2D rect, File outputFile) throws IOException {
        int x = (int) rect.getX();
        int y = (int) rect.getY();
        int w = (int) rect.getWidth();
        int h = (int) rect.getHeight();
        if (w <= 0 || h <= 0) return;

        byte[] rgba = pixels.crop(x, y, w, h);
        if (!GuiAtlasPixels.looksValid(rgba)) return;

        DataBuffer buffer = new DataBufferByte(rgba, rgba.length);
        WritableRaster raster = Raster.createInterleavedRaster(buffer, w, h, 4 * w, 4, new int[]{0, 1, 2, 3}, null);
        ColorModel cm = new ComponentColorModel(ColorModel.getRGBdefault().getColorSpace(), true, true, Transparency.TRANSLUCENT, DataBuffer.TYPE_BYTE);
        BufferedImage image = new BufferedImage(cm, raster, true, null);
        ImageIO.write(image, "png", outputFile);
    }
}
