package assets.resextractor;

import assets.AssetExtractor;

import javax.imageio.ImageIO;
import javax.swing.*;
import java.awt.*;
import java.awt.geom.AffineTransform;
import java.awt.image.*;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.TreeSet;

/**
 * Class extracted from UnityPy https://github.com/K0lb3/UnityPy
 */
public class UnityExtractor {
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

    // TEMP [cloth-bazaar] Dump the raw cloth_bazaar TextAsset (which the normal
    // extraction discards - it's in NON_XML_FILES) so we can reverse-engineer
    // the per-cloth animation (scroll direction / rotate) format. Prints its
    // size, a printable-ASCII preview, and a hex preview of the start.
    public static void dumpClothBazaar(File resourcesAssets) {
        if (resourcesAssets == null || !resourcesAssets.exists()) {
            System.out.println("[cloth-bazaar] resources.assets not found");
            return;
        }
        try {
            Resources res = new Resources(resourcesAssets);
            for (TextAsset t : res.assetTextAsset) {
                if (!"cloth_bazaar".equals(t.name)) continue;
                byte[] b = t.m_Script;
                System.out.println("[cloth-bazaar] size=" + b.length + " bytes");
                int n = Math.min(b.length, 1500);
                StringBuilder ascii = new StringBuilder();
                for (int i = 0; i < n; i++) {
                    int c = b[i] & 0xFF;
                    ascii.append(c >= 32 && c < 127 ? (char) c : '.');
                }
                System.out.println("[cloth-bazaar] ascii[0.." + n + "]=" + ascii);
                int hn = Math.min(b.length, 384);
                StringBuilder hex = new StringBuilder();
                for (int i = 0; i < hn; i++) hex.append(String.format("%02x", b[i]));
                System.out.println("[cloth-bazaar] hex[0.." + hn + "]=" + hex);
                return;
            }
            System.out.println("[cloth-bazaar] not found among "
                + res.assetTextAsset.size() + " text assets");
        } catch (Throwable t) {
            System.out.println("[cloth-bazaar] dump failed: " + t);
        }
    }
}
