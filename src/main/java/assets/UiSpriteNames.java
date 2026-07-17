package assets;

/**
 * Allowlist of named UI sprites cropped from the game's GUI Atlas into the
 * sprite pack's {@code uiSprites} section (issue #205): the enchant-rarity
 * pips and the shiny-item sparkle. Resolution from name to atlas rect
 * happens at extraction time via {@code assets.resextractor.UnityExtractor}
 * joining {@code Sprite.m_RenderDataKey} to the GUI Atlas's
 * {@code SpriteAtlas.m_RenderDataMap} - no coordinates are hardcoded, so
 * adding a future UI sprite is just adding its name below.
 */
public final class UiSpriteNames {
    private UiSpriteNames() {}

    public static final String[] ALLOWLIST = {
        "RarityIcon_1",
        "RarityIcon_2",
        "RarityIcon_3",
        "RarityIcon_4",
        "shiny_item_icon",
    };
}
