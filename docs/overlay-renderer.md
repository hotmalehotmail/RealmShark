# Overlay renderer — panels, sprites, DPS

How the React renderer of the RealmShark overlay works: how it receives the
game packet stream from the main process, the draggable **panel** system, the
shared **sprite/entity** services, and the renderer-side **DPS tracker**. This
is the reference for anyone modifying the HUD. For the Electron main process and
the preload IPC surface see `overlay-main-process.md`; for the sprite-pack
contents see `asset-pipeline.md`; for dye compositing see `dyes-and-textiles.md`;
for the Java DPS engine that feeds this UI see `dps-engine.md`.

> **Path note.** Everything here lives under `overlay/src/renderer/src/` (yes,
> `renderer/src/`, not `renderer/`). Paths below are relative to the repo root.

## Files covered

| File | Role |
| --- | --- |
| `overlay/src/renderer/src/main.tsx` | Entry point; picks main overlay vs. config window by URL hash. |
| `overlay/src/renderer/src/App.tsx` | Top-level shell; wires status/interactive/toast state, mounts providers + canvas. |
| `overlay/src/renderer/src/ConfigWindow.tsx` | Settings form (game-window title, hotkey), shown in the `#config` window. |
| `overlay/src/renderer/src/consoleLog.ts` | In-renderer console capture buffer feeding the Console panel. |
| `overlay/src/renderer/src/DpsList.tsx` | Presentational DPS rows (target + per-attacker list). |
| `overlay/src/renderer/src/env.d.ts` | Vite client types only. |
| `overlay/src/renderer/src/panels/PanelCanvas.tsx` | Owns the panel array, layout load/save, drag/size/pin/z-order dispatch. |
| `overlay/src/renderer/src/panels/PanelFrame.tsx` | One panel's chrome: title bar, drag, size/pin buttons, visibility. |
| `overlay/src/renderer/src/panels/anchor.ts` | Percentage-anchor ↔ pixel math (`panelStyle`, `anchorFromPointer`). |
| `overlay/src/renderer/src/panels/registry.ts` | `type → { title, per-size px dims, component }` and `PanelContentProps`. |
| `overlay/src/renderer/src/panels/{Status,Dps,Console,Character,Instance}Panel.tsx` | The five panel bodies. |
| `overlay/src/renderer/src/sprites/SpriteProvider.tsx` | Loads/decodes the atlas pack; `getSprite` / `getDyedSprite`. |
| `overlay/src/renderer/src/sprites/Sprite.tsx` / `CharacterSprite.tsx` | `<Sprite objectType>` / `<CharacterSprite objectId>` components. |
| `overlay/src/renderer/src/sprites/EntityRegistry.tsx` | objectId → name/skin/equipment/dyes, built from the packet stream. |
| `overlay/src/renderer/src/sprites/context.ts` | The two React contexts + `useSprites` / `useEntityRegistry` hooks. |
| `overlay/src/renderer/src/dps/DpsTracker.ts` | Framework-agnostic class ingesting packets → `DpsSnapshot`. |
| `overlay/src/renderer/src/dps/useDpsTracker.ts` | React hook wrapping `DpsTracker` (subscribe + 200 ms recompute). |
| `overlay/src/renderer/src/dps/types.ts` | Packet-field shapes the tracker reads. |

---

## 1. Bootstrap & data intake

`main.tsx` is tiny: it installs console capture, then renders **one of two
top-level components** by URL hash (`main.tsx:11-15`):

```
window.location.hash === '#config'  →  <ConfigWindow/>   (the settings window)
otherwise                           →  <App/>            (the HUD overlay)
```

Both run in the same bundle; the main process opens the config window with
`#config` appended. Everything else in this doc is the `<App/>` tree.

### The preload bridge is the only data source

The renderer never touches Electron, sockets, or files directly. Its **entire**
window onto the outside world is `window.overlay`, the object
`contextBridge.exposeInMainWorld('overlay', …)` publishes in
`overlay/src/preload/index.ts:15-79`. Two shapes:

- **`invoke`-style** one-shot getters returning a Promise
  (`getBridgeStatus`, `getSettings`, `getPanelLayout`, `getSpritePack`, …).
- **`on…`-style** subscriptions taking a callback and **returning an
  unsubscribe function** (`onPacketBatch`, `onBridgeStatus`, `onSpritePack`,
  `onInteractiveChange`, `onOverlayDetach`, `onMainLogEntry`, …). Every renderer
  effect stores that return and calls it in cleanup.

> **Non-obvious fact — the packet stream is a fan-out, not a store.** There is no
> central packet store in the renderer. Each consumer independently calls
> `window.overlay.onPacketBatch(...)`: `StatusPanel` (counter), `EntityRegistry`,
> and `useDpsTracker` each register their own listener and process the same
> `PacketEnvelope[]` batches. Ordering across consumers is not coordinated.

A `PacketEnvelope` is `{ type, direction, time, data }` (`overlay/src/shared/ipc.ts:61-66`),
with `data: unknown` — each consumer casts `data` to its own field shape. The
stream carries both **real game packets** (`UpdatePacket`, `DamagePacket`, …) and
**synthetic envelopes** the Java bridge injects: `type:"dps"` (the computed DPS
snapshot) and `type:"objectNames"` (enemy names). Those originate in
`src/main/java/bridge/DpsBroadcaster.java` and `ObjectNames.java`; see
`bridge-server.md` / `dps-engine.md`.

### App shell & window modes (`App.tsx`)

`App` holds three pieces of state and subscribes once in a mount effect
(`App.tsx:22-44`):

| State | Source | Effect |
| --- | --- | --- |
| `status` | `getBridgeStatus()` + `onBridgeStatus` | coloured status dot |
| `interactive` | `onInteractiveChange` | whole-HUD input/visibility mode |
| `showAttachToast` | `onAttachSuccess` (auto-hides after 2500 ms) | "RealmShark attached" toast |

`App` also backfills main-process logs on mount: `getBufferedMainLogs()` replays
lines logged before this window existed, then `onMainLogEntry` streams new ones —
both funnelled through `ingestMainEntry` into the same console buffer (§7).

**Interactive mode** is the central UX toggle (driven from the main process by
the global hotkey). When `interactive` (`App.tsx:61-89`):

- a `bg-black/40` backdrop dims the game (rendered only in interactive mode);
- every panel is shown and draggable.

When **not** interactive, only *pinned* panels remain, rendered display-only
(`pointer-events-none`). Crucially, `<PanelCanvas/>` is **always mounted**
(never conditionally rendered) so panels keep their live state — the packet
counter, the whole DPS session — across interactive toggles (`App.tsx:81-87`).
`<SpriteProvider>` and `<EntityRegistryProvider>` wrap the shell so every panel
shares one sprite cache and one entity registry.

---

## 2. The panel system

```
PanelCanvas  ── owns PanelInstance[] (state) ─────────────────────────┐
  │  loads layout via getPanelLayout(), merges defaults               │
  │  saves (debounced 500 ms) via savePanelLayout()                   │
  │  maps each panel → PanelFrame, passing PANEL_REGISTRY[type]       │
  ▼                                                                    │
PanelFrame   ── chrome: title bar, drag handle, size/pin buttons ─────┤
  │  anchor.ts: panelStyle() → absolute % position + capped px size   │
  │  renders <spec.component size={panel.size} />                     │
  ▼                                                                    │
PanelContent (Status/Dps/Console/Character/Instance) ─────────────────┘
```

### Data model (`overlay/src/shared/panels.ts`)

A `PanelInstance` is `{ id, type, anchor, size, zIndex, pinned? }`. Position is a
**percentage anchor**, not pixels: `Anchor = { pos:'tl', x:0-100, y:0-100 }`.
`pos` is currently always `'tl'` (top-left) — kept as a field so a future
multi-corner anchor is a rendering change, not a data migration
(`panels.ts:1-16`). Percent position stays visually correct when the overlay
window (= the game window) resizes, with no reclamp needed.

### Sizing model — three presets, NOT continuous resize

`PanelSize` is the literal union `'sm' | 'md' | 'lg'` (`panels.ts:18`). There is
**no drag-to-resize handle anywhere**. `registry.ts` gives each panel type an
explicit pixel width/height per preset (`registry.ts:21-72`), e.g. DPS is
`180×110 / 260×200 / 320×320`. The size button cycles
`sm → md → lg → sm` via `SIZE_CYCLE` (`PanelFrame.tsx:6`, exported and reused by
`PanelCanvas.tsx:111`). Panels never store pixel dimensions — only the preset
key — so retuning a size means editing the registry, and it applies to every
saved layout.

`panelStyle` (`anchor.ts:17-32`) turns `(anchor, targetSizePx, canvasSizePx)`
into CSS: `top/left` in `%`, and `width/height` in **px capped** so the panel
can't run past the window's right/bottom edge:

```
width  = min(targetPx.width,  ((100 - anchor.x)/100) * canvasWidth)
height = min(targetPx.height, ((100 - anchor.y)/100) * canvasHeight)
```

This capping only bites when a panel is anchored near an edge and the window
later shrinks; otherwise the preset px size is used verbatim.

### Drag / reposition

Dragging is manual (no library). `PanelFrame.startDrag` (`PanelFrame.tsx:34-62`)
records the grab offset within the panel (so the panel doesn't snap its corner
to the cursor), then attaches window `mousemove`/`mouseup` listeners. Each move
calls `anchorFromPointer` (`anchor.ts:35-43`) to convert
`(clientX - grabOffset)` into a **clamped 0-100 % anchor**, and reports it up via
`onDrag`, which does `updatePanel(id, { anchor:{ pos:'tl', x, y } })`
(`PanelCanvas.tsx:108`). Only the drag handle (the title bar) starts a drag, and
only when `interactive`. The pin/size buttons `stopPropagation` on `mousedown` so
clicking them never begins a drag (`PanelFrame.tsx:98,110`). Clicking anywhere on
a panel raises it via `onBringToTop`, which bumps `zIndex` to `max+1`
(`PanelCanvas.tsx:89-94`).

### Layout persistence round-trip

`PanelCanvas` loads once on mount: `getPanelLayout()` → `mergeWithDefaults` → set
state, and marks `loadedRef` (`PanelCanvas.tsx:63-72`). Any later change to the
`panels` array schedules a **500 ms-debounced** `savePanelLayout(panels)`
(`PanelCanvas.tsx:74-83`). The first render is skipped via `loadedRef` so the
pre-load empty array never clobbers a saved layout.

> **Non-obvious fact — defaults are merged, not replaced.** `mergeWithDefaults`
> (`PanelCanvas.tsx:41-47`) keeps every saved panel and *appends* any default
> panel whose `id` isn't present. So a panel type added in a new version appears
> for existing users on upgrade, instead of only on a fresh `panels.json`.

The main process persists `panels.json`; see `overlay-main-process.md`.

### The `PanelContentProps` contract

Every panel body is a `ComponentType<PanelContentProps>` and receives exactly one
prop: `{ size: PanelSize }` (`registry.ts:10-19`). Panels **do not** receive the
packet stream or entity data as props — they reach live data through
`window.overlay.*` subscriptions or the shared contexts (`useSprites`,
`useEntityRegistry`, `useDpsTracker`). They use `size` only to scale their own
content (sprite px, row counts, which optional lines to show).

### How to add a new panel type (checklist)

1. **Write the body** `panels/FooPanel.tsx` as
   `function FooPanel({ size }: PanelContentProps)`. Pull data from a context or
   a `window.overlay.on…` subscription (remember to return the unsubscribe in the
   effect cleanup).
2. **Register it** in `PANEL_REGISTRY` (`registry.ts:21`): add a key with
   `{ type, title, sizes: { sm, md, lg }, component: FooPanel }`. The three
   `sizes` entries are required (they're the only dimensions the panel will ever
   have).
3. **Add a default instance** in `defaultLayout()` (`PanelCanvas.tsx:13-33`) with
   a unique `id`, a non-overlapping `anchor`, a `size`, and a `zIndex`. Thanks to
   `mergeWithDefaults`, existing users pick it up on upgrade.
4. Nothing else — `PanelCanvas` renders any panel whose `type` has a registry
   entry and silently skips unknown types (`PanelCanvas.tsx:99-100`), so a stale
   saved panel referencing a removed type won't crash.

---

## 3. The panels

All five bodies are thin; the data lives in the shared services. `size` maps to
per-panel scale tables at the top of each file.

| Panel | Title | Data source | Notes |
| --- | --- | --- | --- |
| `StatusPanel` | "RealmShark" | `window.overlay.*` directly | Connection dot, hotkey hint, packet count, JS heap MB, app version + **auto-update** UI. |
| `DpsPanel` | "DPS" | `useDpsTracker()` → `<DpsList>` | Rows per attacker vs. the focused enemy (§5). `MAX_ROWS = {sm:3, md:6, lg:12}`. |
| `ConsolePanel` | "Console" | `consoleLog.ts` buffer | Live log with search (Ctrl/Cmd+F), level colours, clear. |
| `CharacterPanel` | "Character" | `EntityRegistry` (local player) | Big dyed sprite + 4 equip icons + username. |
| `InstancePanel` | "Instance" | `EntityRegistry.characters()` | Every named player in the instance, dyed sprites + gear. |

**StatusPanel** (`panels/StatusPanel.tsx`) is the only panel wired straight to
the IPC surface rather than a shared service. It subscribes to `onBridgeStatus`,
`onPacketBatch` (just to count: `packetCount += packets.length`, `StatusPanel.tsx:42-45`),
`onUpdateAvailable`, and `onUpdateProgress`, and polls `performance.memory`
(a non-standard Chrome/Electron field, guarded, `StatusPanel.tsx:14-22`) every
1 s. It also hosts the updater UI (Check / Update & restart) — see
`build-and-release.md`. Content beyond the header is gated on `size !== 'sm'`,
and the last-packet line only on `size === 'lg'`.

**CharacterPanel** and **InstancePanel** (`panels/CharacterPanel.tsx`,
`panels/InstancePanel.tsx`) render through the entity registry + sprite path
(§4). Both share a subtle pattern:

> **Non-obvious fact — panels poll the registry instead of re-rendering on
> packets.** `EntityRegistry` is ref-backed and does **not** re-render on every
> packet. So these panels run a `setInterval(() => setTick(n+1), 500)` purely to
> re-read the registry during their own render cycle (`CharacterPanel.tsx:13-30`,
> `InstancePanel.tsx:13-39`). 500 ms is fine because rosters/gear/dyes change
> slowly; the DPS panel recomputes faster (200 ms) because damage moves fast.

CharacterPanel resolves the local player via `entities.localPlayerId()` and shows
its `CharacterSprite`, the 4 `equipment` slots (empty slots render as bordered
chips), and `name`. InstancePanel lists `entities.characters()` — every objectId
that carries a `NAME_STAT` (players; monsters don't) — sorted with the local
player first (`InstancePanel.tsx:34-39`).

---

## 4. The sprite subsystem

Two independent shared services, both mounted once in `App`:

- **`SpriteProvider`** — the *asset* side: owns the atlas pack and turns an
  `objectType` into a cropped data-URL sprite.
- **`EntityRegistry`** — the *game-state* side: turns an `objectId` into that
  entity's `objectType`, `skin`, `equipment`, dyes, and `name`.

`CharacterSprite` is the bridge between them.

### `SpriteProvider` (`sprites/SpriteProvider.tsx`)

On mount it calls `getSpritePack()` and subscribes to `onSpritePack` (pushed
updates), routing both through `applyPack` (`SpriteProvider.tsx:75-81`).
`applyPack` clears the crop cache, then **decodes each atlas PNG once**
asynchronously with
`createImageBitmap(blob, { colorSpaceConversion:'none', premultiplyAlpha:'none' })`
(`SpriteProvider.tsx:53-59`) — raw decode so sampled pixels match the game's exact
RGBA (a plain `<img>` decode applies ICC/gamma + premultiply rounding). Decoded
bitmaps go in `atlasesRef`; a `setGen` bump (`SpriteProvider.tsx:69`) re-renders
consumers so a sprite that returned `null` before its atlas finished decoding is
retried.

`getSprite(objectType, size)` (`SpriteProvider.tsx:83-108`): look up
`pack.table[objectType]` → `[atlasId,x,y,w,h]`, crop to a `size×size` canvas with
`imageSmoothingEnabled=false` (nearest-neighbour, preserving the pixel-art look),
return `canvas.toDataURL()`, memoised by `"objectType:size"`. Returns `null` when
the pack isn't ready, the objectType is absent, or the atlas hasn't decoded yet.

`getDyedSprite(baseType, size, clothingDye?, accessoryDye?)`
(`SpriteProvider.tsx:120-257`) composites clothing/accessory dyes onto a character
sprite using the pack's `maskTable` + `dyeTable`. The full compositing model
(mask channels = region + shade, textile sub-pixel tiling via `TEXTILE_SUB=5`,
solid vs. textile `dyeTable` encoding) is documented in **`dyes-and-textiles.md`**
— not repeated here. Key contract: it **falls back to `getSprite`** when the pack
isn't ready, there's no dye, or the base type has no mask
(`SpriteProvider.tsx:151-154`), and memoises by
`"dye:baseType:size:clothingDye:accessoryDye"`.

Both functions are exposed via `SpriteContext` (`context.ts:6-30`); panels call
them through `useSprites()` or the `<Sprite>` component.

### `Sprite` and `CharacterSprite`

`Sprite` (`sprites/Sprite.tsx`) takes an `objectType` (+ optional `size`, dyes,
`className`). It picks `getDyedSprite` when a dye is present else `getSprite`
(`Sprite.tsx:37-41`), and renders an `<img style={{imageRendering:'pixelated'}}>`.
When the lookup returns `null` (no real pack / undecoded atlas) it renders a
**deterministic HSL placeholder chip** so an unresolved objectType is still a
stable coloured box (`Sprite.tsx:16-19,55-67`).

`CharacterSprite` (`sprites/CharacterSprite.tsx`) takes an **`objectId`** and
resolves everything from the entity registry: base type is the equipped `skin` if
set, else the class `objectType`; dyes come from `clothingDye`/`accessoryDye`
(`CharacterSprite.tsx:22-34`). It then delegates to `<Sprite>`.

### `EntityRegistry` (`sprites/EntityRegistry.tsx`)

A ref-backed store built from the packet stream. On mount it subscribes to
`onPacketBatch` and `onOverlayDetach` (`EntityRegistry.tsx:100-123`). Per
`objectId` it merges an `EntityRecord` of `objectType`, `skin`, `equipment[4]`,
`clothingDye`, `accessoryDye`, `name`. The stat ids it reads
(`EntityRegistry.tsx:6-10`):

| Const | StatType # | Meaning |
| --- | --- | --- |
| `SKIN_ID_STAT` | 25 | equipped skin objectType |
| `INVENTORY_0_STAT` (+0..3) | 8-11 | the 4 equipped slots (weapon/ability/armor/ring) |
| `NAME_STAT` | 31 | username string |
| `CLOTHING_DYE_STAT` | 32 | Tex1 clothing dye objectType |
| `ACCESSORY_DYE_STAT` | 33 | Tex2 accessory dye objectType |

> **Non-obvious fact — stats are deltas, so records are merged, never replaced.**
> `mergeStats` (`EntityRegistry.tsx:67-98`) reads stats from **both**
> `UpdatePacket.newObjects` (which carries the `objectType`) and
> `NewTickPacket.status` (ongoing deltas, no objectType). A `NewTick` for an
> object never seen in an `UpdatePacket` is skipped, because `objectType` is
> unknown (`EntityRegistry.tsx:73-75`).

The **local player** id is resolved from two packets (`EntityRegistry.tsx:112-117`):
`CreateSuccessPacket.objectId` (authoritative but one-shot, at map load — missed
if the sniffer attaches mid-instance) and `EnemyHitPacket.mainID` (outgoing,
emitted on every one of our hits, so it re-establishes identity continuously).
The registry **clears** on `MapInfoPacket` (instance change) and on
`onOverlayDetach` (`EntityRegistry.tsx:118-123`).

Accessors (`objectType`, `skin`, `equipment`, `name`, `clothingDye`,
`accessoryDye`, `characters`, `localPlayerId`) are `useCallback`-stable and read
the ref synchronously (`EntityRegistry.tsx:130-167`). `characters()` returns every
objectId with a non-empty `name` — i.e. the instance's players.

---

## 5. Renderer-side DPS — and which numbers actually render

### `DpsTracker` (`dps/DpsTracker.ts`)

A framework-agnostic class (no React) that ingests `PacketEnvelope[]` and answers
`snapshot(nowMs)`. Its `ingest` switch (`DpsTracker.ts:82-117`) consumes **six**
envelope types — more than the task's summary implies:

| Envelope | Handler | What it builds |
| --- | --- | --- |
| `CreateSuccessPacket` | sets `localPlayerId` | local-player identity (one-shot) |
| `EnemyHitPacket` | `ingestEnemyHit` | local-player id (from `mainID`) **and** the focus target (from `targetId`) |
| `ServerPlayerShootPacket` | `ingestShoot` | `minionOwners`: minion/pet id → owning player |
| `DamagePacket` | `ingestDamage` | per-target, per-attacker rolling hit buffers |
| `UpdatePacket` | `ingestUpdate` | `entityNames`: objectId → `NAME_STAT` username |
| `objectNames` (synthetic) | `ingestObjectNames` | enemy names resolved bridge-side |
| `dps` (synthetic) | `ingestBridgeDps` | **the Java engine's computed DPS snapshot** |
| `MapInfoPacket` | `reset()` | wipes all state on instance change |

**Focus target.** The tracker only ever reports DPS against *one* enemy: the one
the local player last hit (`focusTargetId`), set from `EnemyHitPacket.targetId`
(`DpsTracker.ts:218-225`) and from a local-player `DamagePacket`
(`DpsTracker.ts:251-256`).

**Local rolling window.** `ingestDamage` (`DpsTracker.ts:228-257`) buckets hits as
`targets[targetId][attackerId] = HitEvent[]`, redirecting a minion's `objectId`
to its owner via `minionOwners` (`DpsTracker.ts:231`). `snapshot` trims each
buffer to the last **`WINDOW_MS = 8000`** ms (`DpsTracker.ts:13,314-332`) and
computes `dps = windowDamage / 8`.

**Reset.** `reset()` (`DpsTracker.ts:260-271`) wipes names, minion map, targets,
focus, and local id. It runs on `MapInfoPacket` internally and is also called from
the hook on detach. Debug counters are deliberately *kept* across resets. Note
`CreateSuccessPacket` does **not** reset — it only sets the local id.

### Which DPS numbers the UI renders — the two paths reconciled

There are two DPS computations in the system, and the UI **prefers the Java
one**:

```
snapshot(focusTargetId):
  1. bridgeEnemies.get(focusTargetId)  ── the {type:"dps"} envelope ──►  IF PRESENT, RENDER THIS
                                              (rows straight from the Java engine)
  2. else targets.get(focusTargetId)   ── local DamagePacket 8 s window ─►  FALLBACK ONLY
```

`snapshot` (`DpsTracker.ts:291-337`) checks `bridgeEnemies` **first** and returns
the bridge rows verbatim when the focused enemy is present there
(`DpsTracker.ts:299-306`). Only if the bridge hasn't sent a snapshot for that
enemy does it fall back to the locally-computed rolling window
(`DpsTracker.ts:308-336`).

> **So: the DPS panel renders the Java `bridge/dps` engine's numbers whenever
> they're available** (the normal case with a real bridge). The renderer's own
> `DamagePacket` accumulator is a **fallback**, used only for an enemy the bridge
> engine hasn't reported yet. This matters because the packet stream alone
> **cannot** see the local player's own damage — the Java engine reconstructs it
> (see `dps-engine.md`), so the fallback path structurally under-reports the local
> player. The comments at `DpsTracker.ts:296-306` and `types.ts:82-101` say this
> explicitly.

Two things the renderer **always** owns regardless of source:

- **The focus target** is chosen locally (from `EnemyHitPacket`/local
  `DamagePacket`); the bridge snapshot is only *looked up* by that id.
- **Player row names** are overridden with the renderer's `entityNames`
  (`NAME_STAT`) map: `this.entityNames.get(p.id) ?? p.name`
  (`DpsTracker.ts:176-181`), because the bridge falls back to a class name
  (e.g. "Wizard") when a player object lacks `NAME_STAT`.

> **Non-obvious fact — names are tracked twice.** `DpsTracker` keeps its **own**
> `entityNames` map from `NAME_STAT`, separate from `EntityRegistry`. DPS rows use
> the tracker's map; the DPS panel's *target sprite* uses `EntityRegistry`
> (`DpsList` calls `entities.objectType(...)`, `DpsList.tsx:26`). They're built
> from the same stat but are independent stores — and the tracker only reads
> `NAME_STAT` from `UpdatePacket`, not `NewTickPacket`.

### `useDpsTracker` (`dps/useDpsTracker.ts`)

The React wrapper: one `DpsTracker` per hook instance (`useState(() => new
DpsTracker())`), a mount effect that pipes `onPacketBatch` into `tracker.ingest`
and `onOverlayDetach` into `tracker.reset()` + empty snapshot, and a
**200 ms** `setInterval` recomputing `snapshot(Date.now())` into React state
(`useDpsTracker.ts:8-33`). Recompute is decoupled from packet arrival so the
rolling window keeps decaying even when no packets flow.

`DPS_DEBUG` (`DpsTracker.ts:21`, currently `false`) gates a `[dps]` diagnostic
channel — per-type counts, one-time field-key dumps, focus transitions, and a
periodic `debugSummary()` (`useDpsTracker.ts:20-23`) — that surfaces in the
Console panel; the fastest way to diagnose "rows show up but read 0" (a wire-field
mismatch). `types.ts` documents the exact Java field names Gson serializes.

---

## 6. ConfigWindow, DpsList, consoleLog

**`ConfigWindow.tsx`** — the `#config` window body. Loads `getSettings()`, edits
`gameWindowTitle` and `toggleHotkey` locally, and `saveSettings()` returns
`{ needsRestart, hotkeyRegistered }` (`ConfigWindow.tsx:17-25`): a window-title
change needs a restart (offered as a "Restart now" button → `relaunch()`), and a
failed hotkey registration is reported inline while the previous hotkey stays.
See `overlay-main-process.md` for how these settings are applied.

**`DpsList.tsx`** — pure presentation for a `DpsSnapshot`. Renders "No target
attacked yet" when `targetId === null`, an optional header with the target sprite
(`<Sprite objectType={entities.objectType(targetId)} />`) + name, then up to
`maxRows` rows of `name — {dps} dps ({damage})`, formatted with
`Math.round(...).toLocaleString()` (`DpsList.tsx:5-46`). It reads
`useEntityRegistry()` only for the target sprite.

**`consoleLog.ts`** — a module-level ring buffer (max 2000 entries,
`consoleLog.ts:10`) with a listener set. `installConsoleCapture()`
(`consoleLog.ts:49-59`, called once in `main.tsx`) monkey-patches
`console.log/info/warn/error` so **every** module's console output is recorded
(and still forwarded to the real console). `ingestMainEntry` merges main-process
log lines into the same buffer prefixed `[main]` (`consoleLog.ts:44-46`).
`ConsolePanel` subscribes via `subscribeLogEntries` and offers substring search
with `<mark>` highlighting, level colours, auto-scroll-when-at-bottom, and clear.

---

## Discrepancies noted while writing

- **Paths.** The task's file list omits a directory level; the real tree is
  `overlay/src/renderer/src/**`, not `overlay/src/renderer/**`.
- **DPS source.** The task summary describes `DpsTracker` as a rolling-window
  computation. That path exists but is the **fallback**; the panel renders the
  Java `bridge/dps` snapshot (`type:"dps"` envelope) whenever present — consistent
  with the memory note "real DPS computed in bridge.dps … self-damage must be
  reconstructed."
- **Local-player + reset.** Local id resolves from `CreateSuccessPacket` **and**
  `EnemyHitPacket.mainID` (the summary mentions only CreateSuccess). Reset fires
  on `MapInfoPacket` and detach, not on CreateSuccess. Both verified in code.
- **Extra ingested envelopes.** `DpsTracker` also consumes the synthetic
  `objectNames` and `dps` envelopes, not just the game packets — worth knowing
  when reasoning about the tracker's inputs.
