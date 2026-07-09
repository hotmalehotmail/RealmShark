package assets;

import assets.flattbuffer.*;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.HashMap;

public class SpriteFlatBuffer {
    private static String spriteJson = "assets/flatbuffer/spritesheetf";

    private static boolean notLoaded = false;
    private static final HashMap<String, HashMap<Integer, Sprite>> sprites;
//    private static final HashMap<String, HashMap<Integer, Sprite>> animatedSprites;

    /**
     * Static class used to load the flat buffer file.
     */
    static {
        sprites = new HashMap<>();
//        animatedSprites = new HashMap<>();
        readFlatBuffer();
    }

    /**
     * Loads the flatBuffer file into HashMap data structure.
     */
    private static void readFlatBuffer() {
        File file = new File(spriteJson);
        if (!file.exists()) {
            notLoaded = true;
            return;
        }
        if (sprites != null) sprites.clear();
//        if (animatedSprites != null) animatedSprites.clear();
        byte[] data;
        try {
            RandomAccessFile f = new RandomAccessFile(file, "r");
            data = new byte[(int) f.length()];
            f.readFully(data);
            f.close();
        } catch (IOException e) {
            notLoaded = false;
            return;
        }

        ByteBuffer buf = ByteBuffer.wrap(data);
        SpriteSheetRoot ssr = SpriteSheetRoot.getRootAsSpriteSheetRoot(buf);

        decodeSheet(ssr);
    }

    /**
     * Decodes spritesheetf into sprite objects
     *
     * @param ssr root flat buffer object.
     */
    private static void decodeSheet(SpriteSheetRoot ssr) {
        int spriteSheetSize = ssr.spritesLength();
        for (int i = 0; i < spriteSheetSize; i++) {
            SpriteSheet spriteSheet = ssr.sprites(i);
            int spritSize = spriteSheet.spritesLength();
            String name = spriteSheet.name();

            HashMap<Integer, Sprite> map = sprites.computeIfAbsent(name, k -> new HashMap<>());
            for (int j = 0; j < spritSize; j++) {
                try {
                    Sprite sprite = getSprite(spriteSheet.sprites(j));
                    map.put(sprite.index(), sprite);
                } catch (Exception e) {
                    System.out.println(name);
                }
            }
        }

        int animatedLength = ssr.animatedSpritesLength();
        for (int i = 0; i < animatedLength; i++) {
            AnimatedSprite animatedSheet = ssr.animatedSprites(i);
            String name = animatedSheet.name();
            HashMap<Integer, Sprite> map = sprites.computeIfAbsent(name, k -> new HashMap<>());

            assets.flattbuffer.Sprite s = animatedSheet.sprites();
            Sprite sprite = getSprite(s);
            sprite.index = (int) animatedSheet.index();
            int direction = (int) animatedSheet.direction();
            int action = (int) animatedSheet.action();
            sprite.setAnimationVars(sprite.index, direction, action, animatedSheet.set());

            reportDirections(name, direction, action);

            // A character skin stores one frame per (action, direction, set); we
            // expose a single representative frame per index. Keep the frame that
            // best matches the preferred facing (right, standing) so character
            // panels render the side view instead of the default front/down one.
            Sprite existing = map.get(sprite.index());
            if (existing == null
                || framePreference(sprite) > framePreference(existing)) {
                map.put(sprite.index(), sprite);
            }
        }

        if (!reportedDirections.isEmpty()) {
            System.out.println("[sprite-facing] animated (sheet -> direction:action) seen: "
                + reportedDirections);
        }
    }

    // ---- Representative-frame facing selection -------------------------------
    //
    // RotMG's animated character sheets store a frame per (action, direction,
    // set). direction/action are small ints defined by the game's own
    // spritesheet data. We can't read that enum from source, so the exact
    // number for "right" is confirmed from the one-time [sprite-facing]
    // diagnostic below; adjust RIGHT_DIRECTION / STAND_ACTION if the log shows
    // different numbering. Selection is a soft preference with fallbacks, so a
    // wrong guess still yields a consistent frame rather than nothing.

    /** action value for the standing (non-walking/attacking) pose. */
    private static final int STAND_ACTION = 0;
    /** direction value that faces right. */
    private static final int RIGHT_DIRECTION = 2;

    // One-time diagnostic: distinct "sheet -> direction:action" tuples, so the
    // real direction/action numbering is visible in the bridge log.
    private static final java.util.TreeSet<String> reportedDirections = new java.util.TreeSet<>();

    private static void reportDirections(String name, int direction, int action) {
        if (name == null) return;
        String lower = name.toLowerCase();
        if (lower.contains("player") || lower.contains("skin") || lower.contains("char")) {
            reportedDirections.add(name + " -> " + direction + ":" + action);
        }
    }

    /**
     * Higher score = better representative frame. Prefers a right-facing frame,
     * then a standing pose, then the first animation set, so the exposed sprite
     * is a stable side view.
     */
    private static int framePreference(Sprite s) {
        int score = 0;
        if (s.animatedDirection == RIGHT_DIRECTION) score += 100;
        if (s.animatedAction == STAND_ACTION) score += 10;
        score += Math.max(0, 5 - s.animatedSet); // earlier set slightly preferred
        return score;
    }

    public static void main(String[] args) throws IOException {
    }

    /**
     * Gets the sprite object from parsed buffer.
     *
     * @param s Buffer sprite object to be extracted
     * @return Sprite object containing sprite data.
     */
    private static Sprite getSprite(assets.flattbuffer.Sprite s) {
        Sprite newSprite = new Sprite();
        newSprite.index = s.index();
        newSprite.aId = (int) s.aId();
        Position position = s.position();
        newSprite.setPosition(position.w(), position.h(), position.x(), position.y());
        Position maskPosition = s.maskPosition();
        if (maskPosition != null) {
            newSprite.setMaskPosition(
                maskPosition.w(), maskPosition.h(), maskPosition.x(), maskPosition.y());
        }
        Color color = s.mostCommonColor();
        newSprite.setColor(color.r(), color.g(), color.b(), color.a());

        return newSprite;
    }

    /**
     * Retrieves sprite coordinates used in sprite atlases based on sprite group name and index.
     *
     * @param name  Name of the sprite group.
     * @param index Index of the sprite in the group.
     * @return Integer
     */
    public int[] getSpriteData(String name, int index) {
        if (notLoaded) return null;
        HashMap<Integer, Sprite> list = sprites.get(name);
//        if (list == null) {
//            list = animatedSprites.get(name);
//        }
        Sprite sprite = list.get(index);
        return new int[]{sprite.positionX, sprite.positionY, sprite.positionW, sprite.positionH, sprite.aId};
    }

    /**
     * Mask coordinates for a sprite (in the characters_masks atlas), or null if
     * the sprite has no mask. The mask marks the dye-able clothing/accessory
     * regions and is used for dye compositing.
     *
     * @param name  Name of the sprite group.
     * @param index Index of the sprite in the group.
     * @return {maskX, maskY, maskW, maskH}, or null when there is no mask.
     */
    public int[] getMaskSpriteData(String name, int index) {
        if (notLoaded) return null;
        HashMap<Integer, Sprite> list = sprites.get(name);
        if (list == null) return null;
        Sprite sprite = list.get(index);
        if (sprite == null || sprite.maskPositionW <= 0) return null;
        return new int[]{
            sprite.maskPositionX, sprite.maskPositionY, sprite.maskPositionW, sprite.maskPositionH
        };
    }

    // TEMP [dye-diag] Which sprite groups carry any mask, and how many. Reveals
    // whether character/player groups have masks at all, or masks live only on
    // some other group (which would explain a base sprite lacking a mask).
    public String describeAllMaskGroups() {
        StringBuilder sb = new StringBuilder();
        int total = 0;
        for (java.util.Map.Entry<String, HashMap<Integer, Sprite>> ge : sprites.entrySet()) {
            int c = 0;
            for (Sprite s : ge.getValue().values()) if (s.maskPositionW > 0) c++;
            if (c > 0) {
                sb.append(ge.getKey()).append('=').append(c).append(' ');
                total += c;
            }
        }
        return "groupsWithMask total=" + total + " :: " + sb;
    }

    // TEMP [dye-diag] Per-index mask presence within one sprite group, so we can
    // see if the mask is simply on a different index than slot 0.
    public String describeGroupMasks(String name) {
        HashMap<Integer, Sprite> list = sprites.get(name);
        if (list == null) return name + ": <no such group>";
        java.util.TreeSet<Integer> maskIdx = new java.util.TreeSet<>();
        for (java.util.Map.Entry<Integer, Sprite> e : list.entrySet()) {
            if (e.getValue().maskPositionW > 0) maskIdx.add(e.getKey());
        }
        return name + ": indices=" + new java.util.TreeSet<>(list.keySet())
            + " maskIndices=" + maskIdx;
    }

    /**
     * Retrieves sprite most common color.
     *
     * @param name  Name of the sprite group.
     * @param index Index of the sprite in the group.
     * @return Integer
     */
    public float[] getSpriteColor(String name, int index) {
        if (notLoaded) return null;
        HashMap<Integer, Sprite> list = sprites.get(name);
        Sprite sprite = list.get(index);
        return sprite.colorAsInt();
    }

    static class Sprite {
        int padding;
        int index;
        int aId;
        boolean isT;
        int positionW;
        int positionH;
        int positionX;
        int positionY;
        int maskPositionW;
        int maskPositionH;
        int maskPositionX;
        int maskPositionY;
        float mostCommonColorR;
        float mostCommonColorG;
        float mostCommonColorB;
        float mostCommonColorA;
        float[] color = new float[4];

        int animatedIndex;
        int animatedDirection;
        int animatedAction;
        int animatedSet;

        public void setAnimationVars(int index, int direction, int action, int set) {
            animatedIndex = index;
            animatedDirection = direction;
            animatedAction = action;
            animatedSet = set;
        }

        public void setPosition(float w, float h, float x, float y) {
            positionW = (int) w;
            positionH = (int) h;
            positionX = (int) x;
            positionY = (int) y;
        }

        public void setMaskPosition(float w, float h, float x, float y) {
            maskPositionW = (int) w;
            maskPositionH = (int) h;
            maskPositionX = (int) x;
            maskPositionY = (int) y;
        }

        public void setColor(float r, float g, float b, float a) {
            mostCommonColorR = r;
            mostCommonColorG = g;
            mostCommonColorB = b;
            mostCommonColorA = a;
            color[0] = r;
            color[1] = g;
            color[2] = b;
            color[3] = a;
        }

        public float[] colorAsInt() {
            return color;
        }

        public int index() {
            return index;
        }
    }
}
