# Dyes & textiles — how the pipeline works

How the overlay renders a character's clothing/accessory **dyes** — both solid
colours and woven **textile** (cloth) patterns — onto its sprite. This is the
reference for the shipped implementation (overlay ≥ 0.9.21). If you touch dye
rendering, read this first.

## The one non-obvious fact

**A dye's colour/pattern is not in any sprite.** A dye is a game object (e.g.
`Deep Pink Clothing Dye`, type `0x1026`). Its `<Texture>` is a *generic shared
icon* — `Deep Pink` and `Honey Dew` resolve to the **same** atlas rect
(`lofiObj3:16`). Sampling that sprite tells you nothing about the colour.

The real colour/pattern lives in the dye object's **`<Tex1>`** element in the
game's object XML, which the asset extractor otherwise ignores. So the whole
feature hinges on parsing `<Tex1>` and reconstructing the cloth ourselves.

## Data flow (end to end)

```
game packet stats 32/33        bridge (Java)                overlay (renderer)
──────────────────────         ─────────────               ──────────────────
CLOTHING_DYE_STAT(32) ─┐       SpritePackService            EntityRegistry
ACCESSORY_DYE_STAT(33)─┤         .buildDyeTable()             tracks clothingDye/
  = a dye objectId      │        parses <Tex1> from           accessoryDye per
                        │        assets/xml  ───► dyeTable ──► objectId
                        │                                     │
                        └────────────────────────────────────┤
                                                              ▼
                                              CharacterSprite → Sprite
                                                              → SpriteProvider
                                                                .getDyedSprite()
                                                                composites & caches
```

1. **The game** sends the equipped dyes as stats on the player's object:
   `CLOTHING_DYE_STAT` = **32** (Tex1) and `ACCESSORY_DYE_STAT` = **33** (Tex2).
   Each value is a **dye objectId** (e.g. `4134`), *not* a colour.
2. **The bridge** builds a `dyeTable` (dyeId → colour/pattern) once per sprite
   pack and ships it in the pack JSON.
3. **The overlay** tracks each object's clothing/accessory dye ids
   (`EntityRegistry`), then `getDyedSprite` recolours the character's mask
   regions using the `dyeTable`.

## The dye data model (`<Tex1>` encoding)

`buildDyeTable` (`bridge/sprites/SpritePackService.java`) scans the extracted
`assets/xml/*.xml` for every `<Object>` with `<Class>Dye</Class>` and reads its
`<Tex1>` (or `<Tex2>`) — a packed 32-bit value whose **high byte** is the type:

| `<Tex1>` example | high byte | meaning | low 24 bits |
| --- | --- | --- | --- |
| `0x01FF1493` | `0x01` (also `0x02`) | **solid** colour | RGB → `(255,20,147)` = Deep Pink |
| `0x0A000019` | `0x0A` = 10 | **textile** | in-group index (`0x19` = 25) |

For a **textile**, the high byte is the **tile-size group**: `0x0A`(10) →
`textile10x10`, and the low bits index into that group. The four textile groups
(`textile4x4`, `textile5x5`, `textile9x9`, `textile10x10`) all live in
**`mapObjects.png` (atlas 4)**, which we already ship — no extra asset needed.

`buildDyeTable` emits, per dye id:

- **solid:** `[1, r, g, b]`
- **textile:** `[10, atlasId, x0,y0,w0,h0, x1,y1,w1,h1, …]` — one 4-tuple **per
  animation frame**, resolved via
  `SpriteFlatBuffer.getSpriteFrames("textile"+size+"x"+size, index)`. A static
  cloth is a single frame; an animated cloth has several (see "Animated
  textiles" below).

This `dyeTable` is added to the sprite-pack JSON alongside `table`
(objectType → rect), `maskTable` (objectType → dye-mask rect), and `atlases`.

## The mask & the compositing model

Character sprites have a companion **dye mask** in `characters_masks.png`
(atlas 3), emitted per objectType into `maskTable`
(`SpriteFlatBuffer.getMaskSpriteData` → `SpritePackService`). In the mask:

- **red channel** marks the **clothing** region, **green** marks **accessory**.
- The channel **value is the shade level** (e.g. `218`, `255`), not a flag.

The undyed body sprite draws the clothing area as `referenceColour ×
(maskValue/255)` (confirmed empirically: base pixels `(156,4,22)` at mask `218`
and `(181,17,33)` at `255`, ratio ≈ `218/255`). So correct dyeing is simply:

```
outputColour = dyeColour × (maskValue / 255)      # per channel
```

This reproduces the game's shading exactly — no reference-colour subtraction, no
sampling the dye's icon. The mask and base sprite are the **same 8×8 resolution**
(the mask is *not* higher-res).

### `getDyedSprite` (`renderer/src/sprites/SpriteProvider.tsx`)

1. Resolve `clothingDye`/`accessoryDye` via `dyeTable` into a `DyeSrc`:
   `{ kind:'solid', rgb }` or `{ kind:'textile', pixels, pw, ph }` (the current
   frame's pattern cropped from its atlas rect). Unknown/absent → `null`
   (renders undyed).
2. Crop the base sprite and its mask.
3. For each output pixel, pick the region by mask channel
   (`mr > 0 && mr >= mg` → clothing; else `mg > 0` → accessory), take
   `shade = maskValue/255`, and write `colour × shade`, keeping the base pixel's
   alpha (silhouette). Non-region pixels pass the base sprite through.
4. Scale the composite to the requested display size with **nearest-neighbour**
   (`imageSmoothingEnabled = false`) to keep the pixel-art look; memoise by
   `dye:${baseType}:${size}:${clothingDye}:${accessoryDye}:${clothingFrame}:${accessoryFrame}`.

### Textile sub-pixel tiling

A textile's weave is **finer than a body pixel** — its stripes are smaller than
the 8×8 grid. Since the mask is only 8×8, we can't get that detail from the mask;
the game tiles the pattern at sub-pixel density. So for textile dyes we composite
at a **subdivided** resolution: `ow = max(w, mw) × TEXTILE_SUB` (and likewise
`oh`). The base and mask are sampled (nearest) at their own low resolution — so
the body outline and shading regions stay blocky — while the pattern is **tiled
in the finer output space** (`px % pw`, `py % ph`), so its weave renders smaller
than a body pixel, matching the game.

`TEXTILE_SUB` (top of `SpriteProvider.tsx`) is the single tuning knob;
**`5`** matches the in-game weave. Solids use `SUB = 1` (unaffected).

### Animated textiles

Some cloths animate. The flatbuffer's `animatedSprites` section stores one entry
per `(name, index, set, direction, action)`; for a `textile*` group the entries
sharing an index (differing by `set`) are the animation frames.
`SpriteFlatBuffer` keeps them all in a `textileFrames` map (character groups
still collapse to one representative frame — see `getSpriteFrames`, ordered by
`set`), so `dyeTable` carries every frame's rect.

The renderer drives animation from a clock in `SpriteProvider`: a `setInterval`
bumps a tick every `frameMs` (only while some dye is a multi-frame textile), and
`getDyedSprite` picks `frame = floor(now / frameMs) % frameCount` for each
textile, crops that frame, and includes it in the memo key — so each tick
re-composites the next frame. Solids and single-frame textiles compute frame `0`
and stay cached (no re-work).

The frame rate is **`textileAnimMs`** in Settings (default **200 ms/frame**),
pushed live to the renderer via the `settingsChanged` IPC — RotMG's own rate
isn't in the assets, so it's tunable. Confirm frame counts with the temporary
`[dye-anim]` bridge log.

## Colour fidelity: raw atlas decode

Atlases are decoded with **`createImageBitmap(blob, { colorSpaceConversion:
'none', premultiplyAlpha: 'none' })`**, not `new Image()`. A plain `<img>` decode
applies the browser's ICC/gamma colour management and premultiply rounding, which
shifts pixel values away from the atlas's raw RGBA (colours drift from in-game,
and anti-aliased edges make identical pixels diverge). Raw decode keeps sampled
pixels exact, which matters both for the dye colour and the base sprite.

## Key files

| File | Role |
| --- | --- |
| `src/main/java/assets/AssetExtractor.java` | Extracts object XML (`assets/xml`) + atlases; only parses `<Texture>` (not `<Tex1>`). |
| `src/main/java/bridge/sprites/SpritePackService.java` | `buildDyeTable()` parses `<Tex1>` from `assets/xml`; emits `table`/`maskTable`/`dyeTable`/`atlases`. |
| `src/main/java/assets/SpriteFlatBuffer.java` | Sprite/mask rects from the flatbuffer; `getSpriteFrames` (all textile animation frames); representative facing-frame selection for character sprites. |
| `overlay/src/shared/ipc.ts` | `SpritePack` type incl. `dyeTable` / `maskTable`. |
| `overlay/src/main/spritePack.ts` | Caches the pack; persists `dyeTable`/`maskTable`; forces a refetch when a cache predates them. |
| `overlay/src/renderer/src/sprites/EntityRegistry.tsx` | Tracks `clothingDye`(32)/`accessoryDye`(33) per objectId from the packet stream. |
| `overlay/src/renderer/src/sprites/SpriteProvider.tsx` | `getDyedSprite` — the compositor (`TEXTILE_SUB` + the textile animation clock live here). |
| `overlay/src/renderer/src/sprites/CharacterSprite.tsx` | `<CharacterSprite objectId>` — resolves skin/class + dyes and renders via `<Sprite>`. |
| `overlay/src/shared/settings.ts` | `textileAnimMs` — textile animation frame duration. |

## Wire-format note

`maskTable` and `dyeTable` are keyed by string ids in JSON. `dyeTable` values are
plain number arrays whose **first element is the kind tag** (`1` solid / `10`
textile) — a consumer must branch on `entry[0]` before reading the rest. A
textile entry is variable length (`[10, atlasId, …4 numbers per frame]`), so its
frame count is `(entry.length − 2) / 4`.

## Gotchas / history

- The old Flash `0x01RRGGBB` "solid colour" encoding **is** used — in the dye
  *object's* `<Tex1>`, not in the player's Tex1/Tex2 *stat* (the stat carries the
  dye objectId). Both facts are true; don't conflate them.
- Textile patterns needed no new atlas — the `textileNxN` groups are already in
  `mapObjects.png` (atlas 4).
- The mask is the same 8×8 as the body sprite; textile fineness comes from
  sub-pixel tiling (`TEXTILE_SUB`), not from higher-res source art.
