# Asset extraction & the sprite pack — how the pipeline works

The overlay renders game sprites (characters, map objects, tiles) and shows
human-readable object names, but the app **cannot ship RotMG's copyrighted
art**. Instead it reads the copy already on the user's machine: at bridge
startup it opens the installed game's `resources.assets`, decodes the Unity
serialized file, and writes the atlas PNGs, the sprite-sheet flatbuffer, and the
object/tile XML into a local `assets/` folder. A second pass boils the XML down
into flat `ObjectID.list` / `TileID.list` tables. The bridge then packages the
four atlases plus a `objectType -> atlas-rect` table into a single JSON "sprite
pack" and ships it to the overlay once per game version; the overlay crops every
sprite itself from that (see [architecture.md](architecture.md) for the wire
protocol and [overlay-renderer.md](overlay-renderer.md) for the client side).

This doc covers the Java extraction + packaging pipeline. Dye colours/patterns
are decoded from the same XML but documented separately in
[dyes-and-textiles.md](dyes-and-textiles.md); this doc cross-links rather than
repeats it.

## Files covered

| File | Role |
| --- | --- |
| `src/main/java/assets/AssetExtractor.java` | Orchestrator: locates `resources.assets`, freshness check, drives extraction, then parses XML → `ObjectID.list`/`TileID.list`. |
| `src/main/java/assets/resextractor/*` | Reverse-engineered Unity serialized-file reader (ported from UnityPy). |
| `src/main/java/assets/resextractor/UnityExtractor.java` | Top-level extract step: writes atlas PNGs, `spritesheetf`, and XML files. |
| `src/main/java/assets/flattbuffer/*` | Generated FlatBuffers schema for RotMG's own sprite-sheet (`SpriteSheetRoot → SpriteSheet → Sprite`/`AnimatedSprite`, `Position`, `Color`). |
| `src/main/java/assets/SpriteFlatBuffer.java` | Loads `spritesheetf`; resolves `(sheetName,index) → atlas rect` / mask rect; representative-frame facing selection. |
| `src/main/java/assets/SpriteJson.java` | Legacy JSON sprite loader; **not used** by the current pipeline (see note). |
| `src/main/java/assets/IdToAsset.java` | Loads the flat lists; resolves `objectType → (textureName, index)`, names, projectiles, tile damage. |
| `src/main/java/assets/ImageBuffer.java` | Desktop (Swing) sprite cropping/outlining from the atlas PNGs; the overlay path does not use it. |
| `src/main/java/bridge/sprites/SpritePackService.java` | Builds/serves the versioned sprite-pack JSON (atlases + `table` + `maskTable` + `dyeTable`). |
| `src/main/java/bridge/ObjectNames.java` | Triggers extraction off-thread at bridge start (best-effort). |

## The problem: input path in, `assets/` out

**Input — the installed game's `resources.assets`.** The path is chosen by OS in
a static initialiser (`assets/AssetExtractor.java:54-79`):

| OS | Path (`REALM_RES_PATH`) |
| --- | --- |
| macOS | `~/.local/share/RealmOfTheMadGod/Production/RotMGExalt.app/Contents/Resources/Data/resources.assets` (`:57-59`) |
| Windows | `%LOCALAPPDATA%/RealmOfTheMadGod/Production/RotMG Exalt_Data/resources.assets`, falling back to the same path relative to CWD if that doesn't exist (`:60-73`) |
| other | `%LOCALAPPDATA%/…/resources.assets` (`:74-78`) — note `getenv("LOCALAPPDATA")` is normally null off-Windows |

`assetFile()` resolves that string to a `File`, returning null and logging if it
doesn't exist (`:317-342`). `setRealmResPath(String)` (`:91-93`) can override it,
and the GUI file-chooser persists a chosen path to the `realmResPath` property
(`:215-218`).

> **Non-obvious fact.** In the bridge (headless) path, nothing calls
> `setRealmResPath` and the persisted `realmResPath` property is **never read
> back** — no `getProperty("realmResPath")` exists in the codebase. The bridge
> only ever tries the OS-default path; a non-standard install location is not
> auto-recovered headlessly.

**Output — files written under `assets/`** (relative to the bridge's working
directory). `UnityExtractor` writes into three folders declared at
`assets/AssetExtractor.java:46-50`:

```
resources.assets
      │  UnityExtractor.extract(file, ASSET_FOLDERS)
      ▼
assets/flatbuffer/spritesheetf     ← RotMG's own sprite-sheet flatbuffer (a TextAsset)
assets/sprites/*.png               ← the 4 atlas PNGs (characters, characters_masks,
      │                              groundTiles, mapObjects)
assets/xml/*.xml                   ← every object/tile TextAsset, as .xml
      │  AssetExtractor.extractAssetsFromXML() (2nd pass)
      ▼
assets/ObjectID.list               ← objectType;display;class;group;proj;texture;labels;name
assets/TileID.list                 ← tileType;texture;damage;name
```

> **Non-obvious fact.** The Java package is `flattbuffer` (double-t) but the
> on-disk folder is `assets/flatbuffer` (single-t), hard-coded in both
> `AssetExtractor.ASSET_FOLDERS` (`:47`) and
> `SpriteFlatBuffer.spriteJson` (`assets/SpriteFlatBuffer.java:13`). Don't
> "fix" the spelling of one without the other.

## Where extraction is triggered (threading & best-effort)

The bridge never blocks on assets. `ObjectNames.init(fake)`
(`bridge/ObjectNames.java:41-60`) spawns a **daemon** `asset-loader` thread that,
in real mode, calls `AssetExtractor.extractHeadless("bridge")` and then
`IdToAsset.reloadAssets()`. Every failure is caught and logged — a missing game,
no Npcap, a headless CI box — so extraction can never take the bridge down; names
and sprites just stay unresolved and the overlay falls back to ids/placeholders.

`extractHeadless(version)` (`assets/AssetExtractor.java:115-123`) is the
GUI-free twin of `checkForExtraction`:

1. `lastEdited(version)` = `resources.assets` last-modified time + `"-" + version`
   (`:125-130`).
2. `checkUpdateAssets` no-ops (returns 0) when both list files exist **and** the
   stored `lastModifiedTime` property matches (`:362-372`); otherwise it runs
   `extractAssets` → `new UnityExtractor().extract(...)` and re-parses the XML.
3. On success it stores the new `lastModifiedTime`, so a subsequent start with an
   unchanged game skips the multi-second extraction entirely.

The GUI path (`checkForExtraction` → `assetExtractionWindow` →
`waitWhileExtracting`, `:98-305`) does the identical work behind a Swing progress
dialog and its own worker thread. `AssetExtractor.pane` (a windowless
`JOptionPane`) is instantiated even headless because `setDisplay(...)` progress
callbacks dereference it (`:116-118`, `:307-309`).

## `resextractor/` — the Unity serialized-file reader

This package is a hand-port of the relevant slice of
[UnityPy](https://github.com/K0lb3/UnityPy) (each file says so). It reads a Unity
**serialized file** (`resources.assets`) with the type tree disabled, pulling out
just three object kinds. It composes like this:

```
FileHeader        classifies the file, finds data_offset & endianness
   │
DataReader        endian-aware primitive reader over a FileInputStream+FileChannel
   │
SerializedFile    header ints → unity_version, platform, types[], objects[]
   │                                                  │
   │                                       ObjectReader[]  (one per asset: path_id,
   │                                                        byte_start, class_id → type)
   ▼
Resources.parseAllResources  switch on ObjectReader.type:
        TextAsset  → TextAsset(o)     (xml + spritesheetf + manifests)
        Texture2D  → Texture2D(o)     (atlas pixels)
        SpriteAtlas→ SpriteAtlas(o)   (parsed but currently unused)
```

### `FileHeader` — classify & orient (`FileHeader.java`)

Reads `metadata_size, file_size, version, data_offset` as four big-endian ints
(`:34-37`). For format `version >= 22` it re-reads the modern layout: a
`bigEndian` flag byte + 3 reserved bytes, then 64-bit `metadata_size`,
`file_size`, `data_offset`, `unknown` (`:39-47`). It then applies a **sanity
heuristic** — if any size is negative, larger than the file, or inconsistent — to
label the file `ResourceFile` vs `AssetsFile` (`:49-53`); only `AssetsFile` is
parsed further (`Resources.java:22-27`).

### `DataReader` — endian-aware primitives (`DataReader.java`)

Wraps a `FileInputStream` + `DataInputStream`. When not big-endian it reassembles
`int`/`long`/`short` from bytes in reverse (`:31-65`). Key helpers the type
readers rely on:

- `alignStream()` — pads to the next 4-byte boundary (`:89-96`); Unity aligns
  after variable-length fields.
- `readAlignedString()` — length-prefixed string, then align (`:126-135`); this
  reads asset `name`s.
- `getPosition()` / `setPosition(int)` — absolute seeks via the underlying
  `FileChannel` (`:108-114`), which is how each object is read at its recorded
  `byte_start`.

> **Non-obvious fact.** `setPosition` takes an `int`, so this reader can only
> seek within the first 2 GiB of the file. `resources.assets` is comfortably
> under that today, but it's a latent ceiling.

### `SerializedFile` — the metadata table (`SerializedFile.java`)

Skips the first 12 ints (`:35-37`, the already-parsed header echo), then reads
`unity_version` (`:39-41`), target `Platform` (`:43-45`), the `enable_type_tree`
flag (`:47-49`), the `types[]` (`SerializedType.getTypes`, `:52-53`), and then
one `ObjectReader` per asset (`:61-70`). Scripts, externals, ref-types and
user-info follow for the relevant format versions.

> **Non-obvious fact.** Two code paths are deliberately unimplemented and
> **throw** rather than mis-parse: a serialized file with the type tree enabled
> (`SerializedType.java:35-55`, `throw new IOException("enable_type_tree")`) and
> any `AssetBundle` object (`SerializedFile.java:115-124`). RotMG's
> `resources.assets` has neither, so the reader is intentionally narrow.

### `SerializedType` (`SerializedType.java`)

`getTypes` reads each type's `class_id` (+ a `script_id`/`old_type_hash` for
MonoBehaviour-ish types, format-version gated, `:21-33`). The type-tree blob
readers are stubbed out (`:62-126`) — dead unless `enable_type_tree`, which
throws anyway.

### `ObjectReader` — one asset's location & class (`ObjectReader.java`)

For each object it reads `path_id` (aligned `long` on modern formats, `:33-40`),
`byte_start` (added to `data_offset` to get the absolute payload offset,
`:42-52`), `byte_size` (`:56-57`), and `type_id` → the `SerializedType`'s
`class_id` (`:59-72`). `class_id` is mapped to the `ClassIDType` enum
(`:74`). The concrete readers later `reader.setPosition((int) o.byte_start)` and
parse in place.

### `ClassIDType` — Unity's class-id enum (`ClassIDType.java`)

A big enum of Unity runtime class ids with an `int → enum` lookup map
(`:379-401`). Only three values matter to the switch in
`Resources.parseAllResources` (`:41-62`): `TextAsset(49)`, `Texture2D(28)`,
`SpriteAtlas(687078895)`. All other cases are explicit no-ops.

### The concrete assets pulled out

**`TextAsset`** (`TextAsset.java`) — a name + raw `m_Script` bytes (`:19-27`). A
`NON_XML_FILES` blocklist (`:9-13`) keeps binary/config text assets out of the
XML dump. `Resources.parseTextAsset` also tags three by name: `spritesheetf`
(the sprite-sheet flatbuffer), `manifest` and `assets_manifest` (`:65-75`).

**`Texture2D` + `TextureFormat`** (`Texture2D.java`, `TextureFormat.java`) —
reads `name`, `m_Width`/`m_Height`, the `TextureFormat` enum value (`:75`), and
the raw `image_data` blob (`:117-121`). `TextureFormat` enumerates every Unity
pixel format; RotMG's atlases are `RGBA32(4)`.

> **Non-obvious fact.** The pixel decode is **not** format-driven. `Texture2D`
> stores `m_TextureFormat` but `UnityExtractor.extractSprites` blindly treats
> `image_data` as tightly-packed RGBA32 (`UnityExtractor.java:105-113`). This
> works only because the RotMG atlases happen to be RGBA32; a DXT/ASTC texture
> would be written as garbage. The reader also assumes a fixed Unity field
> layout — the many `// if version >= …` comments in `Texture2D.java` are the
> version gates that were flattened to constants for RotMG's build.

**`SpriteAtlas`** (`SpriteAtlas.java`) — parses the packed-sprite pointers and
`RenderDataMap` (per-sprite `textureRect`, offsets, `uvTransform`) using `Vec2f`
/ `Vec4f`.

> **Non-obvious fact.** `SpriteAtlas` objects are parsed into
> `Resources.assetSpriteAtlas` but **never consumed** — nothing reads that list.
> The sprite rectangles the overlay actually uses come from RotMG's **own**
> `spritesheetf` flatbuffer (a `TextAsset`), not from Unity's `SpriteAtlas`. So
> the Unity atlas rects here are effectively informational/dead in the current
> pipeline.

**`Resources`** (`Resources.java`) — the driver: `FileHeader` → `SerializedFile`
→ loop over `objects`, dispatching to the readers above (`:35-62`).
`Platform`/`Vec2f`/`Vec4f` are small support types (`Platform` is an `int → enum`
map; `Vec2f`/`Vec4f` are plain float holders).

## `UnityExtractor` — what actually gets written to disk

`extract(input, output[])` (`UnityExtractor.java:24-36`) runs `Resources`, then
writes three things, feeding `AssetExtractor.setDisplay(...)` progress strings as
it goes:

1. **`extractSpritesheet`** (`:89-98`) → writes `res.spritesheet.m_Script`
   verbatim to `assets/flatbuffer/spritesheetf`.
2. **`extractSprites`** (`:100-131`) → for each `Texture2D` whose name is in
   `Texture2D.SPRITESHEET_NAMES = {characters, characters_masks, groundTiles,
   mapObjects}` (`Texture2D.java:11`), wraps `image_data` in an RGBA interleaved
   raster and writes `<name>.png`. It **flips the image vertically** via an
   `AffineTransform` (`:115-123`) because Unity stores textures bottom-up.
3. **`extractXml`** (`:56-73`) → every other `TextAsset` (minus the
   `NON_XML_FILES` blocklist) is written as `<name>.xml`, with `checkDuplicates`
   suffixing collisions `name2`, `name3`, … (`:75-87`).

### Second stage: XML → flat lists (`AssetExtractor`)

`extractAssetsFromXML` (`AssetExtractor.java:377-406`) walks `assets/xml/*.xml`
with a secure `DocumentBuilder`, parses every `<Object>` and `<Ground>` element
into `AssetObject`/`AssetTile` rows (display name, class, group, projectile
min/max/AP, texture `file,index`, labels), sorts by id, and writes them via
`Util.print` to **`assets/ObjectID.list`** and **`assets/TileID.list`**. The
`"-"` suffix passed to `Util.print` (`:399`, `:404`) tells `Util.getPrintWriter`
to use the literal filename with no timestamp (`util/Util.java:95-96`). Only a
subset of child nodes is captured — notably `<Texture>`/`<AnimatedTexture>` for
the sprite lookup (`:548-551`, `:647-665`); dye `<Tex1>`/`<Tex2>` are **not**
extracted here (that parsing lives in `SpritePackService`, see
[dyes-and-textiles.md](dyes-and-textiles.md)).

## The sprite-sheet model (`flattbuffer/`)

`spritesheetf` is a FlatBuffers binary with this shape (generated accessors, do
not edit):

```
SpriteSheetRoot                                   (SpriteSheetRoot.java)
├─ sprites: [SpriteSheet]                          static sprites
│    ├─ name: string        e.g. "characters", "textile10x10"
│    ├─ atlasId: long
│    └─ sprites: [Sprite]                          (SpriteSheet.java)
└─ animatedSprites: [AnimatedSprite]               one frame per (set,dir,action)
     ├─ name, index, set, direction, action        (AnimatedSprite.java)
     └─ sprites: Sprite            (single frame)

Sprite                                            (Sprite.java)
  position:      Position   (atlas rect: x,y,h,w)
  maskPosition:  Position   (dye-mask rect in characters_masks, or empty)
  index:         int        lookup key within a sheet
  aId:           long       atlas id (1-4) → which PNG the rect is in
  mostCommonColor: Color    (r,g,b,a floats)   used for tile minimap colours
  isT, padding, spriteSheetName

Position struct: x, y, h, w (floats)   Color struct: r, g, b, a (floats)
```

### `SpriteFlatBuffer` — the loader/resolver (`SpriteFlatBuffer.java`)

A static block reads `spritesheetf` into
`HashMap<sheetName, HashMap<index, Sprite>>` (`:16`, `:22-54`). `decodeSheet`
(`:61-102`) flattens both static sheets and animated sheets into that one map.
Public resolvers, all keyed by `(sheetName, index)` and returning ints:

- `getSpriteData` → `{x, y, w, h, aId}` — the atlas rect + which atlas (`:163-171`).
- `getAnimationFrames` → all frames of the representative animation (idle,
  right-facing for characters) for a `(name, index)` as
  `{x, y, w, h, aId, maskX, maskY, maskW, maskH}[]`, ordered by `set` (falls
  back to a 1-frame array when not animated) — see [dyes-and-textiles.md](dyes-and-textiles.md).
- `getMaskSpriteData` → `{maskX, maskY, maskW, maskH}` or **null** when the
  sprite has no dye mask (`:182-191`).
- `getSpriteColor` → the sprite's most-common colour (`:200-205`).

> **Non-obvious fact — representative facing frame.** A character skin stores a
> separate animated frame per `(action, direction, set)`, but the map exposes a
> single frame per `index`. `decodeSheet` keeps the frame with the highest
> `framePreference` score (`:96-128`): right-facing (`direction 0`) beats other
> directions, standing (`action 0`) is preferred, earlier `set` breaks ties — so
> character panels render a stable side view instead of a random walk frame.

### `IdToAsset` — objectType → texture (`IdToAsset.java`)

Loads `ObjectID.list`/`TileID.list` into two `HashMap<Integer, IdToAsset>` maps
(`:95-159`). It answers `objectName(id)` (`:172-177`), and — the piece the sprite
pipeline needs — `getObjectTextureName(id, num)` / `getObjectTextureIndex(id,
num)` (`:389-418`), which parse the stored `"index,file,…"` texture string into
`(sheetName, index)` pairs. `objectIds()` (`:196-198`) and
`loadedObjectCount()` (`:186-188`) let the bridge enumerate objects and confirm
assets actually loaded (a missing file leaves the map effectively empty rather
than throwing). Id `-1` is an `"Unloaded"` sentinel (`:123`).

So the full `objectType → atlas rect` chain is:

```
objectType ──IdToAsset.getObjectTextureName/Index──► (sheetName, index)
           ──SpriteFlatBuffer.getSpriteData──────────► {x, y, w, h, aId}
           ──atlas PNG #aId, crop (x,y,w,h)──────────► the sprite
```

### `ImageBuffer` — desktop-side cropping (`ImageBuffer.java`)

`ImageBuffer` performs that final crop for the **Swing desktop app**:
`getImage(id)` runs the chain above and `getSubimage`s the rect out of the atlas
`BufferedImage` cached in `bigImages[aId-1]` (`:39-50`, `:77-82`); the
`spriteSheets` array (`:23`) fixes the atlas order `{groundTiles, characters,
characters_masks, mapObjects}` = ids 1-4. It also builds outlined/glowing icons
(`:118-269`). The **overlay does not use `ImageBuffer`** — it receives the raw
atlas PNGs + rect table in the sprite pack and crops client-side. `ImageBuffer`
is the reference implementation of the same crop the renderer reproduces.

> **Non-obvious fact — `SpriteJson` is legacy/dead.** `SpriteJson.java` is an
> older loader for a JSON sprite sheet at `assets/json/spritesheet.json`
> (`:18`). The current extractor never produces that file (it writes the binary
> `spritesheetf`), and `ImageBuffer` uses `SpriteFlatBuffer` — the `SpriteJson`
> field is commented out (`ImageBuffer.java:19-20`). Treat `SpriteJson` as
> historical; `SpriteFlatBuffer` is the live path.

## `SpritePackService` — assembling the overlay pack

`SpritePackService` (`bridge/sprites/SpritePackService.java`) turns the extracted
assets into the JSON the overlay downloads. It **never triggers extraction
itself** — it only reads what `ObjectNames`/`IdToAsset` already loaded. One
instance lives on `PacketBridge` (`bridge/PacketBridge.java:47`). For the exact
wire-message shapes, see [architecture.md](architecture.md).

**Readiness & version.**

- `ready()` (`:42-44`) — true once `IdToAsset.loadedObjectCount() > 1` **and**
  `assets/sprites/characters.png` exists on disk.
- `version()` (`:58-61`) — `"v" + characters.png.lastModified()`; null when not
  ready. Re-extraction (a game update) changes the file mtime → a new version →
  the overlay refetches.
- `diagnostic()` (`:47-50`) — `"objects=<n> charactersPng=<bool>"`, logged when
  the pack isn't ready so the Console panel shows *why*.

**Version-gated response.** `responseFor(haveVersion)` (`:71-81`) branches three
ways, so a client that already has the pack doesn't re-download multiple MB:

| Condition | Response |
| --- | --- |
| `version() == null` (not ready) | `{"type":"spritePack","ready":false}` |
| client's `haveVersion` equals current | tiny ack: `{"type":"spritePack","ready":true,"upToDate":true,"version":"…"}` |
| otherwise | full `buildPack(v)` payload |

Two call sites drive it: on-demand when a client sends
`{"type":"spritePackRequest","haveVersion":…}` (`PacketBridge.java:60-73`), and a
one-shot broadcast once assets finish loading, polled every 2 s by
`maybeBroadcastSpritePack` (`PacketBridge.java:140-172`) so clients that got an
early not-ready reply still receive the real sprites.

**`buildPack(v)`** (`:84-185`) assembles (and caches by version) a JSON object
with:

- `atlases` — `atlasId(1-4) → data:image/png;base64,…` for each atlas PNG that
  exists. `ATLASES` order matches `ImageBuffer`'s, so index `i` = `atlasId i+1`.
- `table` — `objectType → [atlasId, x, y, w, h]` for every object id, via the
  same `IdToAsset → SpriteFlatBuffer.getSpriteData` chain.
- `maskTable` — `objectType → [3, x, y, w, h]` only for objects that have a dye
  mask (atlas 3 = `characters_masks`), via `getMaskSpriteData`.
- `animTable` — `objectType → flat 9-ints/frame [x,y,w,h,aId,mx,my,mw,mh]` for
  animated (idle) character sprites, via `getAnimationFrames`; only present
  for objectTypes with more than one frame.
- `dyeTable` — `dyeId → cloth`, built by `buildDyeTable` (`:246-337`).
- `animDyeTable` — `dyeId → [type, speed, pivotX, pivotY]`, built alongside
  `dyeTable` (see "The dye table" below).
- `dungeonIcons` — `dungeon display name → spriteId`, built by
  `buildDungeonIcons` (`:198-209`) from `CharacterStatistics`' parallel
  `DUNGEON_NAMES`/`DUNGEONS` lists (`dps/enums/CharacterStatistics.java` — the
  same curated `(pcStatId, spriteId, name)` enum table `docs/dps-engine.md`
  describes for the character-statistics decoder). Static data (no XML/atlas
  read), so cached once and unaffected by `ready()`/version gating beyond the
  rest of the pack. The overlay's `dungeonIcon(name)` (`SpriteProvider.tsx`)
  looks a `MapInfoPacket.displayName` up in this table to resolve a DPS
  summary-panel instance row's icon — see `overlay-renderer.md` §5.

**The dye table.** `buildDyeTable(sfb)` (`:175-243`) is the one piece that reads
the XML directly: it regex-scans `assets/xml/*.xml` for `<Object>`s containing
`<Class>Dye</Class>`, decodes their packed `<Tex1>`/`<Tex2>` value, and emits per
dye id either `[1, r, g, b]` (solid, high byte `0x01`/`0x02`) or
`[10, atlasId, x0,y0,w0,h0, ...]` (textile, high byte = tile-size group, one
4-tuple per animation frame, resolved via
`SpriteFlatBuffer.getAnimationFrames("textile<N>x<N>", idx)`). The full encoding, the
mask-compositing model, and the renderer side are documented in
[dyes-and-textiles.md](dyes-and-textiles.md) — not repeated here.

## Gotchas / non-obvious facts (recap)

- **Best-effort everywhere.** Extraction runs on a daemon thread and swallows all
  failures; the bridge stays up with sprites/names unresolved
  (`bridge/ObjectNames.java:41-60`).
- **Freshness by mtime.** Both `checkUpdateAssets` (`AssetExtractor.java:362-372`)
  and `version()` key off `resources.assets` / `characters.png` last-modified
  time. Touching those files (without a real update) forces a re-extract / a new
  pack version.
- **Only three Unity classes are consumed** (`TextAsset`, `Texture2D`,
  `SpriteAtlas`), and `SpriteAtlas` is parsed but unused — sprite rects come from
  RotMG's own `spritesheetf`, not Unity's atlas.
- **RGBA32 is assumed**, not decoded from `TextureFormat`
  (`UnityExtractor.java:105-113`).
- **`flattbuffer` (package) vs `flatbuffer` (folder)** — the spelling mismatch is
  load-bearing; keep both in sync.
- **`SpriteJson` and `assets/json/spritesheet.json` are legacy** — the live
  loader is `SpriteFlatBuffer` reading `assets/flatbuffer/spritesheetf`.
- **Persisted `realmResPath` is write-only** in the current code — a custom
  install path isn't re-read at headless startup.
