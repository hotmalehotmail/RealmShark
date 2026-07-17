package assets.resextractor;

import java.io.IOException;

/**
 * Partial Unity Sprite (ClassID 213) reader. Reads only {@code name} and
 * {@code m_RenderDataKey} - all {@code assets.resextractor.UnityExtractor}'s
 * UI-sprite join needs to resolve a sprite's name to its atlas rect via
 * {@link SpriteAtlas.RenderDataMap} - then stops; the trailing {@code m_RD}
 * (SpriteRenderData) block is never parsed. Field order verified against a
 * real Unity 6000.0.58f2 dump (issue #205).
 */
public class Sprite {
    String name;
    byte[] renderDataKeyGuid;
    long renderDataKeyFileId;

    public Sprite(ObjectReader o) throws IOException {
        DataReader reader = o.reader;
        reader.setPosition((int) o.byte_start);

        name = reader.readAlignedString();

        reader.readFloat(); // m_Rect.x
        reader.readFloat(); // m_Rect.y
        reader.readFloat(); // m_Rect.width
        reader.readFloat(); // m_Rect.height
        reader.readFloat(); // m_Offset.x
        reader.readFloat(); // m_Offset.y
        reader.readFloat(); // m_Border.x
        reader.readFloat(); // m_Border.y
        reader.readFloat(); // m_Border.z
        reader.readFloat(); // m_Border.w
        reader.readFloat(); // m_PixelsToUnits
        reader.readFloat(); // m_Pivot.x
        reader.readFloat(); // m_Pivot.y
        reader.readUnsignedInt(); // m_Extrude
        reader.readBoolean(); // m_IsPolygon
        reader.alignStream();

        renderDataKeyGuid = reader.readByte(16);
        renderDataKeyFileId = reader.readLong();
    }

    @Override
    public String toString() {
        return "Sprite{name=" + name + "}";
    }
}
