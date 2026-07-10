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

    // TEMP [asset-inv] Enumerate EVERY embedded TextAsset (name + size), flagging
    // which the normal extraction discards (NON_XML_FILES), and print a short
    // ASCII sniff of each discarded one's start. cloth_bazaar turned out to be a
    // map file, not cloth data; this widens the search to find whatever asset (if
    // any) actually holds per-cloth textile-animation data.
    public static void dumpAssetInventory(File resourcesAssets) {
        if (resourcesAssets == null || !resourcesAssets.exists()) {
            System.out.println("[asset-inv] resources.assets not found");
            return;
        }
        java.util.Set<String> discard = new java.util.HashSet<>(
            java.util.Arrays.asList(TextAsset.NON_XML_FILES));
        try {
            Resources res = new Resources(resourcesAssets);
            System.out.println("[asset-inv] textAssets: " + res.assetTextAsset.size());
            // Stable, sorted-by-name listing so the log is easy to scan.
            java.util.List<TextAsset> list = new java.util.ArrayList<>(res.assetTextAsset);
            list.sort((a, b) -> String.valueOf(a.name).compareTo(String.valueOf(b.name)));
            for (TextAsset t : list) {
                int size = t.m_Script == null ? 0 : t.m_Script.length;
                boolean dropped = discard.contains(t.name);
                System.out.println("[asset-inv]   " + t.name + ": size=" + size
                    + (dropped ? " [DISCARDED]" : ""));
            }
            // For discarded (non-XML) assets, sniff the start so a textile/cloth
            // definition reveals itself by its content, not just its name.
            for (TextAsset t : list) {
                if (!discard.contains(t.name)) continue;
                byte[] b = t.m_Script;
                if (b == null) continue;
                int n = Math.min(b.length, 96);
                StringBuilder ascii = new StringBuilder();
                for (int i = 0; i < n; i++) {
                    int c = b[i] & 0xFF;
                    ascii.append(c >= 32 && c < 127 ? (char) c : '.');
                }
                System.out.println("[asset-inv]   sniff " + t.name + "=" + ascii);
            }
        } catch (Throwable t) {
            System.out.println("[asset-inv] dump failed: " + t);
        }
    }
}
