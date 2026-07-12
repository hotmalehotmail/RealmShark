# Overlay renderer — panels, sprites, DPS

How the React renderer of the RealmShark overlay works: how it receives the
game packet stream from the main process, the draggable **panel** system, the
shared **sprite/entity** services, and the renderer-side **DPS tracker**. This
is the reference for anyone modifying the HUD. For the Electron main process and
the preload IPC surface see `overlay-main-process.md`; for the sprite-pack
contents see `asset-pipeline.md`; for dye compositing see `dyes-and-textiles.md`;
for the Java DPS engine that feeds this UI see `dps-engine.md`; for **visual
style** — the design tokens, the shared `ui/` primitives, and the typography/
color conventions every panel must follow — see `overlay-ui-style.md`.

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
| `overlay/src/renderer/src/panels/{Status,Dps,Console,Character,Instance,DpsSummary,Loot}Panel.tsx` | The seven panel bodies. |
| `overlay/src/renderer/src/ui/*.tsx` | Shared UI primitives (`Button`, `EmptyState`, `Swatch`, `GearRow`, `MeterRow`, `StatRow`) — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/assets/main.css` | Tailwind entry + the `@theme` design-token block — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/sprites/SpriteProvider.tsx` | Loads/decodes the atlas pack; `getSprite` / `getDyedSprite`. |
| `overlay/src/renderer/src/sprites/Sprite.tsx` / `CharacterSprite.tsx` | `<Sprite objectType>` / `<CharacterSprite objectId>` components. |
| `overlay/src/renderer/src/sprites/EntityRegistry.tsx` | objectId → name/skin/equipment/dyes, built from the packet stream. |
| `overlay/src/renderer/src/sprites/context.ts` | The two React contexts + `useSprites` / `useEntityRegistry` hooks. |
| `overlay/src/renderer/src/dps/DpsTracker.ts` | Framework-agnostic class ingesting packets → `DpsSnapshot`; also retains a session-scoped per-instance damage history (§5.1). |
| `overlay/src/renderer/src/dps/useDpsTracker.ts` | React hook wrapping `DpsTracker` (event-driven on bridge `dps` packets + 1 s fallback recompute). |
| `overlay/src/renderer/src/dps/useDpsHistory.ts` | React hook owning a dedicated `DpsTracker` instance for the DPS summary panel; exposes `DpsHistoryEntry[]`. |
| `overlay/src/renderer/src/dps/types.ts` | Packet-field shapes the tracker reads. |
| `overlay/src/renderer/src/loot/LootTracker.ts` | Framework-agnostic class ingesting packets → the local player's session-scoped white/orange bag drop log (§7). |
| `overlay/src/renderer/src/loot/useLootTracker.ts` | React hook wrapping `LootTracker` (event-driven on `onPacketBatch`, re-renders only when `ingest` reports a change). |
| `overlay/src/renderer/src/loot/types.ts` | Packet-field shapes the loot tracker reads, incl. the synthetic `lootBagTypes` envelope. |

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
> `useDpsTracker`, and `useLootTracker` each register their own listener and
> process the same `PacketEnvelope[]` batches. Ordering across consumers is not
> coordinated.

A `PacketEnvelope` is `{ type, direction, time, data }` (`overlay/src/shared/ipc.ts:61-66`),
with `data: unknown` — each consumer casts `data` to its own field shape. The
stream carries both **real game packets** (`UpdatePacket`, `DamagePacket`, …) and
**synthetic envelopes** the Java bridge injects: `type:"dps"` (the computed DPS
snapshot), `type:"objectNames"` (enemy names), and `type:"lootBagTypes"`
(BagType 6/8 item categorization for the Loot panel, §7). Those originate in
`src/main/java/bridge/DpsBroadcaster.java`, `ObjectNames.java`, and
`LootBagTypes.java`; see `bridge-server.md` / `dps-engine.md`.

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
explicit pixel width/height per preset (`registry.ts:21-72`), e.g. Character is
a literal `160×100 / 220×130 / 280×170`. The DPS panel's height is instead
*derived* rather than literal: `dpsPanelHeight(size)`
(`dps/rowLayout.ts`) computes the pixel height needed to fit
`DPS_MAX_ROWS[size]` rows (plus the target header and pinned local-player row)
without internal scrolling, currently `180×110 / 260×214 / 320×406`. Any
change to `DPS_MAX_ROWS`/`DPS_ROW_SPRITE_SIZE` or the row markup in
`DpsList.tsx` must keep `dpsPanelHeight`'s constants (row gap, header height,
frame chrome) in sync, since registry sizes are static and can't be measured
from the live DOM. The size button cycles
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
content (sprite px, row counts, which optional lines to show). Base typography
(`text-sm text-fg`) is applied by `PanelFrame`'s content wrapper — panel bodies
inherit it and must not re-declare it (see `overlay-ui-style.md`).

### How to add a new panel type (checklist)

1. **Write the body** `panels/FooPanel.tsx` as
   `function FooPanel({ size }: PanelContentProps)`. Pull data from a context or
   a `window.overlay.on…` subscription (remember to return the unsubscribe in the
   effect cleanup). Style it with the semantic tokens and `ui/` primitives per
   **`overlay-ui-style.md`** — no raw palette classes, no arbitrary text sizes.
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

All six bodies are thin; the data lives in the shared services. `size` maps to
per-panel scale tables at the top of each file.

| Panel | Title | Data source | Notes |
| --- | --- | --- | --- |
| `StatusPanel` | "RealmShark" | `window.overlay.*` directly | Connection dot, hotkey hint, packet count, JS heap MB, app version + **auto-update** UI. |
| `DpsPanel` | "DPS" | `useDpsTracker()` → `<DpsList>` | Rows per attacker vs. the focused enemy, ranked by cumulative damage (§5). `MAX_ROWS = {sm:3, md:6, lg:12}`. Each row also renders that attacker's dyed `CharacterSprite` + equip-slot icons (gear hidden at `sm`), resolved from `EntityRegistry` by `row.objectId`, plus a proportional damage bar and a highlight/rank badge on the local player's row (§6). |
| `ConsolePanel` | "Console" | `consoleLog.ts` buffer | Live log with search (Ctrl/Cmd+F), level colours, clear. |
| `CharacterPanel` | "Character" | `EntityRegistry` (local player) | Big dyed sprite + 4 equip icons + username. |
| `InstancePanel` | "Instance" | `EntityRegistry.characters()` | Every named player in the instance, dyed sprites + gear. |
| `DpsSummaryPanel` | "DPS Summary" | `useDpsHistory()` | Post-fight master/detail: a master list of retained past instances (icon + name + a "You: Xdmg (#rank)" headline), each opening a detail view of that instance's enemies ranked by total damage, expandable to a frozen per-player breakdown. See §5.1. |
| `LootPanel` | "Loot" | `useLootTracker()` | Session log of the local player's white/orange bag drops (BagType 6/8), grouped under each color's own bag sprite as a category header, chronological (not de-duplicated) within each. See §7. |

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

> **Non-obvious fact — panels re-render via a registry subscription, not a
> poll.** `EntityRegistry` is ref-backed and does **not** re-render on every
> packet by itself, so these panels call `entities.subscribe(() => setTick(n+1))`
> in a mount effect purely to force a re-read of the registry on the next render
> (`CharacterPanel.tsx:24-25`, `InstancePanel.tsx:24-26`). The registry only
> notifies on a *display-relevant* change (skin/equipment/dye/name, local-player
> id, instance reset), coalesced to one notification per animation frame (§4),
> so there's no idle re-render churn even though rosters/gear/dyes now update
> near-instantly, same as the DPS panel (§5).

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

`getSprite(objectType, size)` (`SpriteProvider.tsx:164-189`): look up the current frame's rect (from
`pack.animTable[objectType]` for an animated idle sprite, else `pack.table[objectType]`)
→ `[atlasId,x,y,w,h]`, crop to a `size×size` canvas with
`imageSmoothingEnabled=false` (nearest-neighbour, preserving the pixel-art look),
return `canvas.toDataURL()`, memoised by `"objectType:size:frame"`. Returns `null` when
the pack isn't ready, the objectType is absent, or the atlas hasn't decoded yet.

`getDyedSprite(baseType, size, clothingDye?, accessoryDye?)`
(`SpriteProvider.tsx:204-361`) composites clothing/accessory dyes onto a character
sprite using the pack's `maskTable` + `dyeTable`. The full compositing model
(mask channels = region + shade, textile sub-pixel tiling via `TEXTILE_SUB=5`,
solid vs. textile `dyeTable` encoding) is documented in **`dyes-and-textiles.md`**
— not repeated here. Key contract: it **falls back to `getSprite`** when the pack
isn't ready, there's no dye, or the base type has no mask
(`SpriteProvider.tsx:217,227`), and memoises by
`"dye:baseType:size:clothingDye:accessoryDye:baseFrame:clothingFrame:accessoryFrame"`
(the base frame only varies for an animated idle character; the dye frames only
vary for animated textiles — see `dyes-and-textiles.md`).

Both functions (plus `isAnimated`/`frameMs`) are exposed via `SpriteContext` (`context.ts:6-37`); panels call
them through `useSprites()` or the `<Sprite>` component.

### `Sprite` and `CharacterSprite`

`Sprite` (`sprites/Sprite.tsx`) takes an `objectType` (+ optional `size`, dyes,
`className`). It picks `getDyedSprite` when a dye is present else `getSprite`
(`Sprite.tsx:51-53`), and renders an `<img style={{imageRendering:'pixelated'}}>`.
When the lookup returns `null` (no real pack / undecoded atlas) it renders a
**deterministic HSL placeholder chip** so an unresolved objectType is still a
stable coloured box (`Sprite.tsx:16-19,67-79`). It also ticks its own animation
clock: `isAnimated(objectType, clothingDye, accessoryDye)` (from `SpriteContext`)
says whether this particular sprite has an idle-frame or textile-frame animation,
and only then does a local `setInterval` at `frameMs` re-render it
(`Sprite.tsx:37-45`) — static sprites and event-driven panels never tick.

`CharacterSprite` (`sprites/CharacterSprite.tsx`) takes an **`objectId`** and
resolves everything from the entity registry: base type is the equipped `skin` if
set, else the class `objectType`; dyes come from `clothingDye`/`accessoryDye`
(`CharacterSprite.tsx:22-34`). It then delegates to `<Sprite>` — except when the
registry has no `objectType` at all for that `objectId` yet (e.g. a DPS row for a
player the registry hasn't seen an `UpdatePacket` for), in which case it renders
the same bordered-chip placeholder as an unresolved equipment slot instead of
nothing, so callers never get a blank gap.

### `EntityRegistry` (`sprites/EntityRegistry.tsx`)

A ref-backed store built from the packet stream. On mount it subscribes to
`onPacketBatch` and `onOverlayDetach` (`EntityRegistry.tsx:129-164`). Per
`objectId` it merges an `EntityRecord` of `objectType`, `skin`, `equipment[4]`,
`clothingDye`, `accessoryDye`, `name`. The stat ids it reads
(`EntityRegistry.tsx:6-10`):

| Const | StatType # | Meaning |
| --- | --- | --- |
| `SKIN_ID_STAT` | 25 | equipped skin objectType |
| `INVENTORY_0_STAT` (+0..3) | 8-11 | the 4 equipped slots (weapon/ability/armor/ring) |
| `NAME_STAT` | 31 | username string — comma-separated on the wire (`"PlayerName,a0ca,…"`); only the part before the first comma is kept, dropping the trailing title/label cosmetic codes (matches the bridge's `Entity.name()`) |
| `CLOTHING_DYE_STAT` | 32 | Tex1 clothing dye objectType |
| `ACCESSORY_DYE_STAT` | 33 | Tex2 accessory dye objectType |

> **Non-obvious fact — stats are deltas, so records are merged, never replaced.**
> `mergeStats` (`EntityRegistry.tsx:89-127`) reads stats from **both**
> `UpdatePacket.newObjects` (which carries the `objectType`) and
> `NewTickPacket.status` (ongoing deltas, no objectType). A `NewTick` for an
> object never seen in an `UpdatePacket` is skipped, because `objectType` is
> unknown (`EntityRegistry.tsx:95-97`). `mergeStats` returns `true` when a
> display-relevant field (skin/equipment/dye/name) actually changed, which is
> how the registry decides whether to notify subscribers (below).

The **local player** id is resolved from two packets (`EntityRegistry.tsx:144-157`):
`CreateSuccessPacket.objectId` (authoritative but one-shot, at map load — missed
if the sniffer attaches mid-instance) and `EnemyHitPacket.mainID` (outgoing,
emitted on every one of our hits, so it re-establishes identity continuously).
Both guard on an actual id change, since `EnemyHitPacket` arrives every hit but
should only count as a display change the first time it resolves. The registry
**clears** on `MapInfoPacket` (instance change) and on `onOverlayDetach`
(`EntityRegistry.tsx:77-81`). Individual records are **removed** when their
objectId appears in `UpdatePacket.drops` (the entity left view / the instance),
so the roster reflects players *leaving* as well as joining — if the local
player's own id drops, `localPlayerRef` is forgotten too.

**`subscribe(cb)`** (`EntityRegistry.tsx:59-64`) lets a panel register a
callback instead of polling. Any batch that contains a display-relevant change
sets a local `changed` flag and calls `scheduleNotify()`
(`EntityRegistry.tsx:66-75`), which coalesces a burst of packets into a single
`requestAnimationFrame` call to every subscriber — see the `CharacterPanel`/
`InstancePanel` callout in §3.

Accessors (`objectType`, `skin`, `equipment`, `name`, `clothingDye`,
`accessoryDye`, `characters`, `localPlayerId`) are `useCallback`-stable and read
the ref synchronously (`EntityRegistry.tsx:171-211`). `characters()` returns every
objectId with a non-empty `name` — i.e. the instance's players.

---

## 5. Renderer-side DPS — and which numbers actually render

### `DpsTracker` (`dps/DpsTracker.ts`)

A framework-agnostic class (no React) that ingests `PacketEnvelope[]` and answers
`snapshot(nowMs)`. Its `ingest` switch consumes **seven** envelope types — more
than the task's summary implies:

| Envelope | Handler | What it builds |
| --- | --- | --- |
| `CreateSuccessPacket` | sets `localPlayerId` | local-player identity (one-shot) |
| `EnemyHitPacket` | `ingestEnemyHit` | local-player id (from `mainID`), a last-hit focus signal (via `onLocalHit`), and a despawn signal when `kill` is set |
| `ServerPlayerShootPacket` | `ingestShoot` | `minionOwners`: minion/pet id → owning player |
| `DamagePacket` | `ingestDamage` | per-target, per-attacker rolling hit buffers, and a last-hit focus signal for the local player's own attributed hits |
| `UpdatePacket` | `ingestUpdate` | `entityNames` (`NAME_STAT`), `enemyMaxHp` (`MAX_HP_STAT`), `objectTypes` (every seen objectId's `objectType`), `playerCosmetics` (skin/equipment/dyes, for history's frozen per-player sprite — §5.1), and a despawn signal per dropped id |
| `objectNames` (synthetic) | `ingestObjectNames` | enemy names resolved bridge-side |
| `dps` (synthetic) | `ingestBridgeDps` | **the Java engine's computed DPS snapshot** |
| `QuestObjectIdPacket` | `ingestQuestObjectId` | locks/re-locks the sticky boss focus, carrying forward the prior phase's damage on a phase change |
| `MapInfoPacket` | `retainInstanceIfQualifying()` then `reset()` | freezes the ending instance's damage into session history (§5.1) if it qualifies, *then* wipes all live state for the new instance |

**Focus target — sticky quest-objective lock, falling back to last-hit.** The
tracker reports DPS against *one* enemy (`focusTargetId`), chosen by:

1. **Quest-objective lock** (`lockedBossId`, `bossAlive`, `bossDamagedByLocal`)
   — armed from `QuestObjectIdPacket.objectId` (`ingestQuestObjectId`), the
   game's own boss/objective marker (in a dungeon, the main boss), but the
   lock does **not** actually take effect — and `focusTargetId` is **not**
   forced onto it — until the local player lands a hit on it
   (`bossDamagedByLocal`, set the first time `onLocalHit`'s `targetId` equals
   `lockedBossId`); until then, focus keeps following last-hit as if no
   objective were active, so the panel doesn't jump to a boss the player
   hasn't reached yet. A phase transition on an already-*damaged*, still-*alive*
   encounter (`bossDamagedByLocal` carried over — see point 3 below) does snap
   focus straight to the new phase, since that's a continuation of an engaged
   fight; but if the previous lock had already despawned (`bossAlive` false) by
   the time the new objective arrives, `bossDamagedByLocal` resets instead —
   that's a genuinely new objective, not a phase continuation, and should be
   treated the same as a fresh, undamaged encounter (`ingestQuestObjectId`).
   Once damaged-and-alive, every last-hit signal on anything else
   (`onLocalHit`, called from both `ingestEnemyHit` and `ingestDamage`) is a
   no-op — AoEing adds cannot steal focus from the boss — **unless** overridden
   by a sustained-attack streak (point 3). The lock only moves when either
   (a) a *different*, non-zero objective id arrives (a phase/form change
   re-points the objective at the next phase's entity), or (b) the locked
   entity despawns (`onBossDespawn`, driven by `EnemyHitPacket.kill` on it or
   its id appearing in `UpdatePacket.drops`) — at which point `bossAlive` goes
   false and last-hit resumes until a new objective re-locks. Despawning does
   **not** itself clear `focusTargetId`, so the panel keeps showing the final
   numbers rather than blanking mid-transition.
2. **Last-hit fallback** (`maybeSwitchFallbackFocus`) — used whenever no quest
   objective is locked-and-damaged (open world, a not-yet-damaged objective, or
   after the locked boss despawned with no new objective yet). Ordinarily this
   is plain last-hit, same as before this feature; the one refinement is that
   a hit on a new target does **not** steal focus away from the current one
   when both entities' `MAX_HP_STAT` are known (from `UpdatePacket`, no bridge
   dependency) and the current target's is larger — so an AoE tick on a small
   add can't flip focus off a bigger enemy already being fought. Falls
   straight through to plain last-hit whenever either max-HP is unknown, which
   is the common case.
3. **Sustained-attack override** — even once damaged-and-locked, a hit on the
   boss itself always reclaims focus immediately (the player isn't sustaining
   anything else anymore). But if the player continuously hits one *other*
   target for `SUSTAINED_ATTACK_MS` (2000ms) straight — tracked per-hit by
   `updateLocalStreak`/`localStreakDurationMs`, reset the instant the hit
   target changes — that streak overrides the lock and `focusTargetId` moves
   to it, on the read that a deliberate, unbroken 2+ second switch away from
   the objective is intentional, unlike a stray AoE tick. The streak (and
   `bossDamagedByLocal`) persists across a phase transition, since that's the
   same encounter continuing.

**Boss-phase damage carryover — only across a *live* phase change.** A boss
changing form gets a brand-new `objectId` server-side (a new `Entity` in the
bridge's `DpsEngine`, damage total starting at zero — see the discrepancy
note in `dps-engine.md`), so carrying a boss's total across phases is
entirely the renderer's job. `ingestQuestObjectId` calls
`carryForwardBossDamage` on the *previous* `lockedBossId` before switching,
but **only when that previous lock is still alive** (`bossAlive` true) — a
genuine phase/form change on the same encounter. It snapshots the previous
lock's current per-attacker damage (`totalDamageRows` — bridge rows if
present, else the summed local buffer) into `bossCarry`. `snapshot()` then
takes the `bossSnapshot` branch whenever `bossCarry` is non-empty and the
focus is still the locked boss: each row's `damage` is `bossCarry + the
current phase's live damage`, while `dps` is just the current phase's live
rate (not a whole-encounter average).

If the previous lock had already **despawned** (`bossAlive` false) by the
time a new objective arrives, it is *not* a phase change — it's an unrelated
new encounter (the next quest boss; the common case in the open-world Realm,
which cycles through many independent quest bosses with no instance change
between them, but equally possible in any instance with more than one
distinct boss). Carrying that dead boss's damage forward here would
misattribute it to whichever boss locks next — the bug behind "the DPS
summary attributes a Realm quest boss's damage to the *next* quest boss
instead of the one that was just killed." Instead, `ingestQuestObjectId`
calls `resolveBossChain()`, which bakes the just-finished chain (its own
`bossSnapshot`, merging any still-unflushed `bossCarry` from that chain's own
earlier phases) into its own `resolvedBossEncounters` entry — see §5.1's
"Boss-phase merging" — and clears `bossCarry` so the new chain starts at
zero rather than inheriting the old one's total.

**Local rolling window.** `ingestDamage` buckets hits as
`targets[targetId][attackerId] = HitEvent[]`, redirecting a minion's `objectId`
to its owner via `minionOwners`. `snapshot` trims each buffer to the last
**`WINDOW_MS = 8000`** ms and computes `dps = windowDamage / 8`.

**Reset.** `reset()` wipes names, minion map, targets, focus, local id, the
boss lock (`lockedBossId`/`bossAlive`/`bossDamagedByLocal`/`bossCarry`), the
local attack streak (`localStreakTargetId`/`localStreakStartedAt`),
`enemyMaxHp`, `objectTypes`, `playerCosmetics`, and `bossPhaseIds` — all
*per-instance* state. It runs on
`MapInfoPacket` internally (after `retainInstanceIfQualifying()` — §5.1) and is
also called from the hook on detach (which skips retention — see §5.1). Debug
counters and the retained `history`/`historySeq`/`currentInstanceName` are
deliberately *kept* across resets — they're session-scoped, not per-instance.
Note `CreateSuccessPacket` does **not** reset — it only sets the local id.

### 5.1 Retained instance history (the DPS summary panel)

`DpsTracker` also retains a session-scoped, in-memory history of past
instances' damage, so a separate **DPS summary panel** (`DpsSummaryPanel.tsx`)
can show a post-fight master/detail view with no time pressure — unlike the
live DPS panel (§3), which only ever shows the currently-focused enemy.

**The hook: `MapInfoPacket`, before `reset()`.** Every instance ends the same
way the tracker learns about it starting: a `MapInfoPacket`. `ingest()` calls
`retainInstanceIfQualifying()` on the *about-to-end* instance's still-live
state, **then** `reset()` wipes it, **then** `currentInstanceName` is set from
the new packet's `displayName` (`MapInfoPacketData.displayName` — the
human-readable name, e.g. `"Oryx's Sanctuary"`, matching the bridge's
`dungeonIcons` table keys; `name` is a machine id and unrelated), passed
through `resolveInstanceDisplayName()` first. `displayName` is the raw
localization *key* — the real client resolves it client-side through its own
string table, which RealmShark never sees — so for a map with no dungeon-style
name of its own (the open-world Realm) it arrives unresolved, literally
`"{s.rotmg}"`. `resolveInstanceDisplayName` maps that known key to `"The
Realm"` and, for any other unrecognized `{...}`-shaped key, falls back to a
generic `"Unknown Realm"` rather than leaking the raw key into the DPS summary
panel.

**Log-gating.** `retainInstanceIfQualifying` skips instances with no real
fight: it requires either some enemy's total damage (`totalDamage`, summed
across `players`) to reach `HISTORY_LOG_MIN_DAMAGE` (a tunable constant, a
proxy for "a boss-scale enemy was fought"), or a quest objective to have been
engaged at all (`lockedBossId !== null` **or** a chain already resolved into
`resolvedBossEncounters`) even if the fight was cut short. Nexus/vault/realm
hops/rushed-empty rooms fall under both and are silently skipped — no history
entry, no user-visible signal.

**Boss-phase merging — one merged entry per *encounter*, not per instance.**
`buildHistoryEnemies()` builds the ranked enemy list for a history entry
from three sources: `resolvedBossEncounters` (finished chains — see below),
the flat non-boss enemies in `bridgeEnemies`, and one merged entry for the
still-open chain (`lockedBossId`, if any). Without this split, a boss whose
`objectId` changed across phases would appear as several split entries — one
per raw id, each showing only that phase's damage — **or**, if two *different*
bosses were merged together, one boss's damage would be mislabeled onto the
other (see the "Boss-phase damage carryover" discrepancy this fixes, §5).
`bossPhaseIds` (populated by `ingestQuestObjectId` alongside `bossCarry`'s
carry-forward and `resolveBossChain`'s bake-out — see §5) tracks every phase
id *any* boss chain has ever used this instance, live or finished; those ids
are excluded from the flat per-enemy loop since each is already accounted for
in `resolvedBossEncounters` or the still-open chain's merged entry.

`resolveBossChain()` is what keeps distinct encounters from bleeding into
each other: the moment `ingestQuestObjectId` sees a new objective for a boss
that already despawned (not a phase of the one that just ended), it bakes the
finished chain's `bossSnapshot()` into its own `resolvedBossEncounters` entry
*before* the new chain starts accumulating — so a Realm's next quest boss
starts from zero rather than inheriting the damage of the one the player just
killed. Both the finished-chain bake-out and the live merged entry for the
still-open chain reuse `bossSnapshot()` (the same carry-forward merge the
*live* panel uses for a phase-changing boss — §5's "Boss-phase damage
carryover"). This is also why the merge is **not** the bridge's
`bossPhaseDamage` field: per the discrepancy note in `dps-engine.md`, that
field only flags three specific counter-damage mechanics and does not
aggregate a boss's damage across
phase/objectId changes — the renderer has always been the one place that does,
and history reuses that same mechanism rather than duplicating it.

**Frozen cosmetics, not a live `EntityRegistry` lookup.** A history entry must
still render correctly long after the instance ended, but `EntityRegistry`
(§4) clears itself on every `MapInfoPacket` — by the time a user opens an old
entry, its players' `objectId`s may resolve to nothing, or worse, to a
different instance's different player. So `DpsTracker` keeps its own
`playerCosmetics` map (objectId → skin/equipment/clothingDye/accessoryDye),
merged from `UpdatePacket` the same way `EntityRegistry` does but kept
independent, and a history entry's `DpsHistoryEnemy.cosmetics` is a **snapshot
copy** taken at retention time. `DpsSummaryPanel.tsx`'s `FrozenCharacterSprite`
renders directly from that frozen record (`<Sprite objectType clothingDye
accessoryDye>`), never through `CharacterSprite`/`useEntityRegistry`.

**Shape.** `getHistory(): DpsHistoryEntry[]` returns the retained list, newest
first, capped at `HISTORY_MAX_INSTANCES` (oldest dropped). Each
`DpsHistoryEntry` is `{ id, instanceName, endedAt, localPlayerId, enemies:
DpsHistoryEnemy[] }`; each `DpsHistoryEnemy` is `{ id, name, objectType,
players: PlayerDps[], cosmetics: Map<objectId, PlayerCosmetics> }`, sorted
descending by total damage. `objectType` (the enemy's own, from `objectTypes`)
feeds the master-list icon fallback chain (§3): dungeon-icon map
(`useSprites().dungeonIcon(instanceName)`) → the top-ranked enemy's
`objectType` (the "main-boss sprite") → a generic placeholder chip.

**A separate tracker instance, not the live panel's.** The summary panel's
`useDpsHistory()` hook (`dps/useDpsHistory.ts`) constructs its **own**
`DpsTracker`, independent from `DpsPanel`'s (via `useDpsTracker()`) — both
ingest the identical packet stream (`window.overlay.onPacketBatch`)
independently, so history-tracking never perturbs the live glance panel and
vice versa. `<PanelCanvas/>` being always mounted (§1, "Interactive mode")
keeps every panel *in the layout* alive across interactive toggles, but a
panel only mounts its `Content` component at all once `PanelCanvas` renders
its `<PanelFrame/>` — which it does for every entry in `panels`, visible or
not (`PanelFrame.tsx`'s `display: visible ? undefined : 'none'` hides it
without unmounting). Since `dpsSummary` is in `defaultLayout()`, its tracker
keeps ingesting (and retaining) for the app's whole session even while the
panel itself is hidden — the "session-scoped" part of the retention contract
depends on this always-in-layout property, not on the user having the panel
open.

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

- **The focus target** is chosen locally (sticky quest-objective lock, falling
  back to `EnemyHitPacket`/local `DamagePacket` last-hit — see above); the
  bridge snapshot is only *looked up* by that id.
- **Player row names** are overridden with the renderer's `entityNames`
  (`NAME_STAT`) map: `this.entityNames.get(p.id) ?? p.name`
  (`DpsTracker.ts:176-181`), because the bridge falls back to a class name
  (e.g. "Wizard") when a player object lacks `NAME_STAT`.

> **Non-obvious fact — names are tracked twice.** `DpsTracker` keeps its **own**
> `entityNames` map from `NAME_STAT`, separate from `EntityRegistry`. Row *names*
> come from the tracker's map; each row's *sprite/gear* (`CharacterSprite` +
> equip icons) and the header's target sprite come from `EntityRegistry`
> (`DpsList` calls `entities.objectType(...)` for the header and
> `entities.equipment(...)`/`CharacterSprite` per row). They're built from the
> same underlying stats but are independent stores — and the tracker only reads
> `NAME_STAT` from `UpdatePacket`, not `NewTickPacket`.

### `useDpsTracker` (`dps/useDpsTracker.ts`)

The React wrapper: one `DpsTracker` per hook instance (`useState(() => new
DpsTracker())`), a mount effect that pipes `onPacketBatch` into `tracker.ingest`
and immediately re-snapshots whenever a batch contains a `dps` envelope
(`useDpsTracker.ts:17-26`) — the bridge pushes one within ~50 ms of any damage
packet (coalesced) plus a 250 ms heartbeat (see `bridge-server.md`) — or a
`QuestObjectIdPacket` envelope, so a boss lock/phase transition renders
immediately rather than waiting for the 1 s fallback tick below. This keeps the
panel effectively event-driven, not polled — `onOverlayDetach` into
`tracker.reset()` + empty snapshot, and a slow **1000 ms** `FALLBACK_INTERVAL_MS`
`setInterval` recomputing `snapshot(Date.now())` (`useDpsTracker.ts:31-34`) that
exists only so the client-side rolling-window fallback (used when the bridge
has no data for the focused enemy) still decays when packets go quiet.

`DPS_DEBUG` (`DpsTracker.ts:21`, currently `false`) gates a `[dps]` diagnostic
channel — per-type counts, one-time field-key dumps, focus transitions, and a
`debugSummary()` logged on every fallback tick (`useDpsTracker.ts:33`) — that
surfaces in the Console panel; the fastest way to diagnose "rows show up but
read 0" (a wire-field mismatch). `types.ts` documents the exact Java field
names Gson serializes.

---

## 6. ConfigWindow, DpsList, consoleLog

**`ConfigWindow.tsx`** — the `#config` window body. Loads `getSettings()`, edits
`gameWindowTitle`, `toggleHotkey`, and `textileAnimMs` (a slider, 50-1000ms)
locally, and `saveSettings()` returns `{ needsRestart, hotkeyRegistered }`
(`ConfigWindow.tsx:17-25`): a window-title change needs a restart (offered as a
"Restart now" button → `relaunch()`), and a failed hotkey registration is
reported inline while the previous hotkey stays. See `overlay-main-process.md`
for how these settings are applied.

**`DpsList.tsx`** — pure presentation for a `DpsSnapshot`, now also takes the
panel's `size` (`sm`/`md`/`lg`) so rows can scale down. Renders "No target
attacked yet" when `targetId === null`, an optional header with the target sprite
(`<Sprite objectType={entities.objectType(targetId)} />`) + name, then always
exactly `maxRows` fixed-height slots — real rows ranked by **cumulative damage
on the focused target** (both the bridge `dps` path and the local-estimate
fallback sort `rows` descending by `damage` — `DpsTracker.ts` — so the two
paths agree on ranking even though the fallback still tracks a rolling `dps`
figure too), with any unfilled slots rendered as blank placeholder rows
(`selectVisibleRows()`) so the list's total rendered height never changes as
players enter/leave the rolling damage window.

Each row is `<CharacterSprite objectId={row.objectId}>` (the attacker's dyed
skin/class sprite, same path `CharacterPanel` uses) + that player's 4
equip-slot icons (`entities.equipment(row.objectId)`, empty slots as bordered
chips, hidden entirely at `sm` — `ROW_SLOT_SIZE.sm = 0` — the one "reduced
detail" concession for the smallest panel size) + the truncating name + the
damage total as the primary figure, with rolling `dps` demoted to a smaller
secondary figure beside it. Numbers are formatted **compact**
(`formatCompact`: `12.3k`, `1.2m`) rather than `toLocaleString()`, so the
total/dps figures stay narrow enough to survive next to a sprite + 4 gear
icons in a ~180-320px-wide panel (`DpsList.tsx`).

**Damage bar + self row.** Each row is a `<MeterRow>` (`ui/MeterRow.tsx` — see
`overlay-ui-style.md`): a proportional bar rendered as a **row background
fill** (an absolutely-positioned `div` sized `damage / topDamage`, painted
behind a `relative z-10` wrapper holding the sprite/gear/name/numbers) so it
never competes with them for horizontal space, and stays meaningful even
at `sm` where the gear icons are hidden. The row is clipped
(`overflow-hidden rounded-sm`) so the fill can never overflow the row or panel.
Every row, real or placeholder, gets an explicit fixed height (`rowHeight`,
via `MeterRow`'s `height` prop) so the list's total rendered height is
constant regardless of how many rows are real vs. blank.

The local player's row (`row.objectId === entities.localPlayerId()`,
`MeterRow`'s `highlight` prop) gets an accent ring, a tinted fill, and a
`#rank` badge ahead of its name giving its true position in the full
(unsliced) ranking. Two layers keep that row always present:
`ensureLocalRow()` synthesizes a 0-damage row
for the local player if they haven't hit the focused target at all yet (the
bridge/local-estimate `rows` only ever contain attackers who've actually
landed damage, so absence otherwise means "no row"), then `selectVisibleRows()`
decides where it renders. The local player's row stays in its natural ranked
position, in order with everyone else's, whenever that position already falls
within the visible `maxRows` window — it is **not** pulled out of the ranked
list unconditionally. Only when their true rank would otherwise fall *outside*
`maxRows` does it get pinned into the list's last slot (displacing the
lowest-ranked other row), so the player can still always find themselves even
at 0 damage or well outside the top N. Either way the `#rank` badge shows
their true position in the full ranking, which only differs from their
rendered position in that pinned-out-of-range case.

It reads `useEntityRegistry()` for the target sprite, the local player's id
(`localPlayerId()`), and, per row, `objectType`/`skin`/dyes (via
`CharacterSprite`) and `equipment` — all keyed by `row.objectId`, which is
already the *owning player's* id even for pet/minion damage (the bridge's
`DpsEngine.minionOwnerMap` and the local-estimate fallback's `minionOwners` map
both attribute to the owner before the row is ever built — see
`dps-engine.md`), so a summoned entity never gets its own row.

**`consoleLog.ts`** — a module-level ring buffer (max 2000 entries,
`consoleLog.ts:10`) with a listener set. `installConsoleCapture()`
(`consoleLog.ts:49-59`, called once in `main.tsx`) monkey-patches
`console.log/info/warn/error` so **every** module's console output is recorded
(and still forwarded to the real console). `ingestMainEntry` merges main-process
log lines into the same buffer prefixed `[main]` (`consoleLog.ts:44-46`).
`ConsolePanel` subscribes via `subscribeLogEntries` and offers substring search
with `<mark>` highlighting, level colours, auto-scroll-when-at-bottom, and clear.

---

## 7. Loot panel — session-scoped BagType log

The Loot panel (issue #105) tracks every item the local player picks up whose
game-data `BagType` is 6 (white bag) or 8 (orange/ST bag) — the two colors
players actually screenshot — grouped under each color's own bag sprite.
Categorization is entirely asset-derived (no hand-maintained item list): see
[asset-pipeline.md](asset-pipeline.md)'s "BagType — loot categorization"
section for how `<BagType>` is extracted and shipped as the bridge's synthetic
`lootBagTypes` envelope, and [bridge-server.md](bridge-server.md) §6 for the
bridge-side broadcast mechanics.

### `LootTracker` (`loot/LootTracker.ts`)

A framework-agnostic class (no React, same shape as `DpsTracker`) that ingests
`PacketEnvelope[]` independently of every other tracker/registry — its own
local-player resolution (`CreateSuccessPacket` + `EnemyHitPacket.mainID`,
identical to `EntityRegistry`/`DpsTracker`'s approach) and its own
`Map<statTypeNum, lastValue>` of the local player's 8 bag inventory slots
(`INVENTORY_4..11`, wire `statTypeNum` 12-19 — the 4 *equipped* slots
`EntityRegistry` already reads are 8-11, a distinct range).

**"Obtained" detection.** A bag slot transitioning from empty (`<= 0`, or never
seen) to a populated item id is logged as a pickup — the same shape a real
pickup takes (landing in a free bag slot), and the one transition that can't
also mean "dropped" (populated → empty) or "reconnected mid-session" (an
already-known value re-arriving). The new item's `objectType` is looked up in
`bagTypeTable` (from the `lootBagTypes` envelope); if it isn't BagType 6 or 8,
nothing is logged. Two different bag slots holding the *same* item id both log
their own entry — the log is chronological, not a de-duplicated set, so two
of the same white-bag item dropping in one session both appear.

**Session-scoped, mirroring `DpsTracker`'s retained history (§5.1).**
`entries` (the loot log itself) persists across `MapInfoPacket` (instance
change) and is cleared only by `reset()` (overlay detach / game close) — the
same split `DpsTracker` uses between its per-instance live state and its
retained cross-instance history. `MapInfoPacket` only calls
`resetPerInstance()` (forgets the local player id + last-known slot values, so
a fresh full-inventory resend after a map change doesn't misfire against
stale slot state), never touching `entries`. `bagTypeTable`/`lootBagIcons`/
`itemNames` (the asset-derived categorization data itself) are deliberately
never cleared by either reset — like the sprite pack, they're app-lifetime
data, not session state.

### `useLootTracker` (`loot/useLootTracker.ts`)

One dedicated `LootTracker` instance per hook call (same pattern as
`useDpsHistory`), piping `onPacketBatch` into `tracker.ingest`. Unlike
`useDpsTracker`'s always-re-snapshot-on-relevant-envelope approach,
`ingest()` itself returns whether anything display-relevant changed (new
entry logged, or the `lootBagTypes` meta updated), so the hook only
re-renders on an actual change — loot events are rare compared to DPS
churn, so there's no fallback poll timer here.

### `LootPanel` (`panels/LootPanel.tsx`)

For each tracked BagType (6, 8), if it has zero entries the whole category is
hidden; if the panel has zero entries across *both* colors it shows the
shared `EmptyState` instead. A non-empty category renders its bag-color
sprite (`bagIcon(bagType)`, resolved through the ordinary `<Sprite
objectType>` path — no special-casing) plus a count, then every obtained
item as its own sprite, **newest first** so the latest drop is visible
without scrolling. Each item sprite carries its resolved name (`itemName`,
falling back to `#<objectType>` if unresolved) as a native `title` tooltip at
every size, and additionally inline beside the sprite at `size === 'lg'` — the
"at least a name on hover, or beside the sprite at larger sizes" acceptance
bar. Sized/registered via the standard checklist (§2): `registry.ts`'s `loot`
entry, a default-layout instance in `PanelCanvas.tsx`.

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
