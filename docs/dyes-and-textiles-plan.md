# Dyes & textiles — plan + debug log

## ✅ SOLVED (v0.9.16-alpha) — solid dyes render correctly; textiles located

Solid dyes now render their true color. The long debug is resolved. Key correction to
every earlier assumption: **the dye's color/pattern is NOT in any sprite.** The dye
object's texture is a generic shared *icon* (proven: Deep Pink 4134 and Honey Dew 4149
resolve to the exact same rect `lofiObj3:16`). The real color is in the **dye object's
XML `<Tex1>`** (which the extractor never parsed):
- **Solid**: `<Tex1>0x01RRGGBB</Tex1>` — e.g. Deep Pink = `0x01FF1493` = (255,20,147).
- **Textile**: `<Tex1>0x0A00IIII</Tex1>` — high byte `0x0A`(10), low bits = textile index
  (Large Lemon-Lime = `0x0A000019`, index 25).

**Compositing model (confirmed from `[dye-mask]`):** the `characters_masks` mask marks
clothing (red channel) / accessory (green channel); the **channel value is the shade
level** (e.g. 218 and 255). The undyed sprite is literally `referenceColor ×
(maskValue/255)`, so correct dyeing is `dyeColor × (maskValue/255)` per channel. No
reference subtraction, no icon sampling.

**What shipped (v0.9.16-alpha):**
- `bridge/sprites/SpritePackService.buildDyeTable()` scans `assets/xml` for
  `<Class>Dye</Class>`, parses `<Tex1>`/`<Tex2>`, emits `dyeTable[dyeId]` =
  `[1,r,g,b]` (solid) or `[10,idx]` (textile).
- `SpriteProvider.getDyedSprite` recolors the mask region via the shade formula above.
- Textiles resolve to `null` → render **undyed** for now.

### ▶ NEXT: textiles (v0.9.17-alpha diagnostic in flight)

Textile patterns exist as sprite groups **`textile4x4` / `5x5` / `9x9` / `10x10`**
(found via `[dye-groups]`). Hypothesis: textile `Tex1` high byte = tile-size group
(`0x0A`→`textile10x10`), low bits = in-group index. Two unknowns gated by the
`[dye-textile]` diagnostic: (1) which **atlas** those groups live in — `ImageBuffer`
only ships 4 (`groundTiles`,`characters`,`characters_masks`,`mapObjects`); if textiles
are `aId` 5+ we must extract a 5th atlas + ship it; (2) confirm the size→group /
index mapping. Then: emit a textile table + atlas, tile the pattern into the mask
region using the same shade formula.

## (historical) ⏳ v0.9.8 — dyes implemented but NOT rendering; mid-debug

Dye compositing IS implemented (v0.9.6) and shipped, but dyes **don't render** on the
user's character. We're actively debugging. Resume here.

**What works / is known:**
- Dyes decode + arrive on `Tex1`(32)=clothing / `Tex2`(33)=accessory as **object IDs**
  (not colors). Confirmed live: floral-white=4149, textiles=4741/4967. Both dye ids
  resolve in the sprite pack (`inTable=true`, atlas 4 = mapObjects.png, `drawable=true`).
- `EntityRegistry` tracks `clothingDye`/`accessoryDye` and passes them through
  `<CharacterSprite>` → `<Sprite>` → `SpriteProvider.getDyedSprite`.
- The pack now emits a `maskTable` and it's populated: **`maskTable=3404`** masks.

**The bug (as of v0.9.8):** for the character's **base** sprite, `getDyedSprite` logs
`ready=true baseInTable=true maskInTable=FALSE, clothing inTable, accessory inTable`.
So the base sprite has **no mask entry**, so `getDyedSprite` falls back to the plain
(undyed) sprite. Since 3404 other sprites DO have masks, the base sprite specifically
lacks one.

**Leading hypothesis:** the user is wearing a **skin**, so base = skin objectType, and
the skin's sprite has no `maskPosition` in the pack while the class body sprite does.
v0.9.8 adds a `[dye-char] skin=X(mask=?) class=Y(mask=?)` log to confirm skin-vs-class.
**Awaiting that log line.**

**Next step (pick up here):**
1. Read the `[dye-char]` line from the user.
   - **skin mask=false, class mask=true** → skin-specific. Can't borrow the class mask
     (shaped for the class sprite; would misalign on the skin). Need to find how Exalt
     keys a skin's dye mask (maybe a different texture name/index; check
     `IdToAsset.getObjectTextureName(skinId, num)` for num>0, or a separate mask sprite
     group). Possibly the skin has no mask at all in the data and dyes genuinely don't
     apply to it in-game (verify against the live client).
   - **class mask=false too** → the mask lookup itself is wrong: the mask is on a
     different texture index/animation frame than index 0. Fix
     `SpriteFlatBuffer.getMaskSpriteData` / `SpritePackService` to search other indices.
2. Once fixed, verify the compositor (mask channel mapping red=clothing/green=accessory,
   tiling, mask atlas=3) against a live dyed character; the r/g test in
   `SpriteProvider.getDyedSprite` may need swapping.

**Temporary diagnostics to REMOVE once dyes render** (grep `TEMP`, `[dye`, `dye-probe`):
- `EntityRegistry.tsx` dye-probe (`[dye-probe]` + `spritesRef`/`describeSprite` use).
- `SpriteProvider.tsx` `describeSprite`, `hasMask`, `dyeDiagRef` + the `[dye]` log.
- `context.ts` `describeSprite`/`SpriteLookup`/`hasMask`.
- `CharacterSprite.tsx` `[dye-char]` log + `loggedChar`.
- `SpritePackService.java` `[sprite-pack] built …` log.
- (Keep the real dye pieces: `maskTable` emission, `getDyedSprite` compositor, dye
  tracking, `<Sprite>` dye props, `<CharacterSprite>`.)

---

## Original plan (kept for reference)

Status as of overlay **v0.9.3**. Character sprites (skins + equipment) shipped;
**dyes are not started** — this is the plan we agreed to come back to.

## Where we are

- **Done:** enemy icons (DPS panel) and the Character panel (skin + equipment)
  render through the shared sprite system (`SpriteProvider` / `<Sprite objectType>` /
  `EntityRegistry`). Sprites are cropped client-side from a one-time "sprite pack"
  the bridge builds from the four extracted atlases.
- **Not done:** any dye / cloth cosmetics. No dye stat handling, no mask emission,
  no compositor.

## LIVE CAPTURE (2026-07-09, v0.9.4 dye-probe) — corrects the old assumptions

Captured the local player's `Tex1`/`Tex2` in Exalt via the dye-probe:
- clothing **textile** = `0x1285` (4741)
- accessory **textile** = `0x1367` (4967)
- clothing **solid** "Floral White" = `0x1035` (4149)

Two conclusions:
1. ✅ **Dyes are on `Tex1`(32)=clothing / `Tex2`(33)=accessory**, already decoded. No
   Java `StatType` change needed. (Confirmed live.)
2. ❗ **The `0x01RRGGBB` "solid color" encoding is WRONG for Exalt.** Even a solid dye
   ("Floral White") is a small **object ID** (4149), not a packed RGB. So **every dye,
   solid and textile alike, is just an object ID** — the color/pattern is NOT in the
   packet. The RealmEye/AS3 `0x01RRGGBB` form is the old Flash client.

**Revised render model (unified):** a dye is an object with a texture — a solid swatch
for solid dyes, a pattern for textiles. Rendering is the **same for both**: resolve the
dye `id → its sprite`, then tile it into the clothing/accessory mask region. There is no
separate "fill with RGB from the packet" path.

**The single remaining question that gates ALL dye rendering** (not just textiles):
is the dye object's sprite in the pack we already ship (one of the 4 atlases), or in a
separate dye/textile spritesheet we don't extract? → answered by the v0.9.5 pack-lookup.

### ✅ RESOLVED (v0.9.5 pack-lookup): dyes are fully renderable with what we ship

For the captured dye ids the probe reported **`inPack=true atlas=4 drawable=true`**. So:
- Dye sprites (solid swatches AND textile patterns) already live in **`mapObjects.png`
  (atlas 4)** — they're in the sprite pack table today, and `getSprite(dyeId)` crops them.
- **No `AssetExtractor` change, no 5th atlas, no textile-sheet extraction needed.** The
  earlier "textiles won't work / need a separate sheet" concern is **moot** — solid and
  textile dyes are the same case and both ship.

So the whole dye feature is now a self-contained, normal-sized piece: track the dye ids,
emit the mask rect, composite. No blocked/deferred sub-part.

## Old key findings (kept for reference; point 2 superseded above)

1. Dyes on `TEX1_STAT(32)` / `TEX2_STAT(33)` — confirmed live (see above).

2. ~~Two kinds of dye distinguished by high bits; solid = `0x01RRGGBB` (color in the
   packet), textile = index into a textile sheet.~~ **Superseded:** live capture shows
   ALL dyes (solid included) are object IDs; color is never in the packet.

3. **Mask data is half-plumbed.** `assets/flattbuffer/Sprite.java` exposes
   `maskPosition()`, and `characters_masks.png` is already one of the four shipped
   atlases. But `assets/SpriteFlatBuffer.java` never reads `maskPosition()` and
   `bridge/sprites/SpritePackService.java` only emits the base `[atlasId,x,y,w,h]` —
   the mask rect is defined in the schema but never populated or sent. (Still true;
   mask emission is needed regardless of the dye-source outcome.)

## What needs to change — SOLID-color dyes (the achievable first cut)

- **`src/main/java/assets/SpriteFlatBuffer.java`** — in `getSprite(...)`, also read
  `s.maskPosition()` (guard for null) and populate the already-declared
  `maskPosition*` fields; add a `getMaskSpriteData(name,index)` returning
  `{mx,my,mw,mh}` (mask always lives on the `characters_masks` atlas = atlasId **3**).
- **`src/main/java/bridge/sprites/SpritePackService.java`** — emit a parallel
  `maskTable[objectType] = [3, mx, my, mw, mh]` (parallel table keeps the existing
  5-tuple consumers working; only present for objectTypes that have a mask). No new
  asset transfer — `characters_masks.png` already ships.
- **`overlay/src/shared/ipc.ts`** — add optional `maskTable` to the `SpritePack` type.
- **`overlay/src/renderer/src/sprites/EntityRegistry.tsx` + `context.ts`** — track
  `clothingDye` / `accessoryDye` from stats 32/33 (same delta-merge pattern already
  used for skin/equipment); add accessors.
- **`overlay/src/renderer/src/sprites/SpriteProvider.tsx`** — add a dye-aware crop:
  draw base sprite → crop mask from atlas 3 → tint the masked region toward the dye
  RGB → composite → memoize by a dye-inclusive cache key
  (`${objectType}:${size}:${clothingDye}:${accessoryDye}`).
- **`overlay/src/renderer/src/panels/CharacterPanel.tsx`** — pass the local player's
  dye values into the dyed-sprite call (first consumer).

## Textiles — why they DON'T work with the above, and what they'd need

The plan above only handles solid-color dyes. Textile dyes need pixels we don't have:

- Our sprite pack ships only **4 atlases** (`groundTiles`, `characters`,
  `characters_masks`, `mapObjects`). The textile patterns live in a **separate
  spritesheet** that `AssetExtractor` does **not** extract, that isn't in the pack,
  and that we have **no id→rect mapping** for. A repo-wide search found no textile/
  dye/cloth asset anywhere.
- So even with the textile dye value decoded, there's **no source image to paint**.

Textile support would additionally require:
1. Identify the textile spritesheet in Exalt's `resources.assets` and its coordinate
   data, and extend `AssetExtractor` to extract it (same pipeline as the other 4).
2. Ship it as a **5th atlas** + a `textile-id → rect` table in the pack.
3. A **tiling** compositor branch (fill mask by repeating the pattern, not a flat
   color) — and handle any **animated** textiles.

## Options

- **Option A — Solid-color dyes only (recommended first).** Moderate, self-contained:
  mask emission (Java) + a canvas compositor (renderer). Uses only assets we already
  ship. Textile-dyed characters render un-dyed (or a flagged placeholder).
- **Option B — Solid + textile.** Everything in A, plus the textile extraction + 5th
  atlas + tiling/animated compositor. Bigger, more unknowns (textile sheet identity,
  animation).
- **Option C — Defer entirely.** Character panel already shows skin + equipment; dyes
  are pure cosmetic polish.

## Open unknowns / verification needed before building

1. **Confirm dyes arrive on stats 32/33** (vs. an Exalt-specific number) — via a live
   local-player capture. Blocking.
2. **Exact solid-vs-textile bit discriminator** in the packed int (`0x01RRGGBB` solid
   confirmed; textile high-byte layout not).
3. **Mask channel semantics** — flash-client lore says the mask's **red channel =
   clothing region, green = accessory**; verify against a live dyed character, plus
   the blend math (multiply vs replace, tint strength).
4. **Whether textiles animate** (affects the textile compositor).

## Recommended path forward when we resume

1. Add a **temporary "dump my character's stats" diagnostic** to a build; capture the
   local player's `newObjects` stats in-game and read the raw `Tex1`/`Tex2` values.
2. Confirm stats 32/33 carry dyes and eyeball a couple of values to lock the
   solid-vs-textile bit layout.
3. Implement **Option A** (solid dyes): mask emission + compositor, verify against a
   known solid-dyed character.
4. Decide on **Option B** (textiles) separately once solid dyes work.

## References

- RealmEye wiki — Dyes and Cloths (Tex1 = clothing, Tex2 = accessory; packed hex)
- RealmEye wiki — Character Stats
- RotMG-Proxy-Alpha `Stats.cs` (Texture1 = 32, Texture2 = 33)
- Perturb/AS3-RotMG `EmbeddedData_DyesCXML.dat` (dye definitions)
