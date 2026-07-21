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
| `overlay/src/renderer/src/DpsSparkline.tsx` | The standalone `dpsGraph` panel's bare-SVG trend line over the recorder's aggregate series (§5.2) — the one place the graph's presentation lives (binding layering contract, `prd-dps-graph.md` §4). Smoothed curve + compositor-only bin-tick slide (issue #259). |
| `overlay/src/renderer/src/env.d.ts` | Vite client types only. |
| `overlay/src/renderer/src/panels/PanelCanvas.tsx` | Owns the panel array, layout load/save, drag/size/pin/z-order dispatch, programmatic open/close. |
| `overlay/src/renderer/src/panels/PanelFrame.tsx` | One panel's chrome: title bar, drag, size/pin/close/settings-gear buttons, visibility. |
| `overlay/src/renderer/src/panels/panelSpawn.ts` | `PanelSpawnContext` / `usePanelSpawn()` - lets a panel body open/close another panel on the canvas (§2's "Programmatic panel spawn/close"). |
| `overlay/src/renderer/src/panels/anchor.ts` | Percentage-anchor ↔ pixel math (`panelStyle`, `anchorFromPointer`). |
| `overlay/src/renderer/src/panels/registry.ts` | `type → { title, per-size px dims, component, closable?, ephemeral?, settings? }`, `PanelContentProps`, and `PanelSettingsProps` (§2's "Per-panel settings gear", issue #221). |
| `overlay/src/renderer/src/panels/panelLayout.ts` | `defaultLayout()`/`mergeWithDefaults()`/`isPersistablePanel()` plus the pure open/close transitions (`withPanelOpen`/`withPanelClosed`/`isPanelOpen` - §2's "Closeable panels") - split out of `PanelCanvas.tsx` (a component file can't also export plain functions - `react-refresh/only-export-components`), same rationale as `dps/dpsDetailContext.ts`. |
| `overlay/src/renderer/src/panels/{Status,Dps,DpsGraph,Console,Character,Instance,DpsSummary,DpsDetail,Loot,Notifications}Panel.tsx` | The ten panel bodies. |
| `overlay/src/renderer/src/ui/*.tsx` | Shared UI primitives (`Button`, `EmptyState`, `Swatch`, `GearRow`, `MeterRow`, `StatRow`, `Tooltip`) — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/ui/interactiveContext.ts` | `InteractiveContext` / `useInteractive()` - the click-through-mode flag, for `Tooltip` (§4.2). |
| `overlay/src/renderer/src/assets/main.css` | Tailwind entry + the `@theme` design-token block — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/sprites/SpriteProvider.tsx` | Loads/decodes the atlas pack; `getSprite` / `getDyedSprite`. |
| `overlay/src/renderer/src/sprites/outline.ts` | `outlineImageData`/`dilateSilhouette` — bakes RotMG's thin black silhouette outline into a cropped/composited sprite. |
| `overlay/src/renderer/src/sprites/Sprite.tsx` / `CharacterSprite.tsx` | `<Sprite objectType>` / `<CharacterSprite objectId>` components. |
| `overlay/src/renderer/src/sprites/EntityRegistry.tsx` | objectId → name/skin/equipment/equipmentRarity/enchantSlots/dyes, built from the packet stream. |
| `overlay/src/renderer/src/sprites/context.ts` | The two React contexts + `useSprites` / `useEntityRegistry` hooks. |
| `overlay/src/renderer/src/sprites/enchantRarity.ts` | Decodes `UNIQUE_DATA_STRING` into a per-slot rarity-border tier (issue #107) — see §4.1. |
| `overlay/src/renderer/src/sprites/shiny.ts` | `SHINY_ICON_SPRITE_NAME` - shininess itself comes from the bridge's dedicated `shinyItemTypes` signal (issue #193/#215), read by `LootTracker.isShiny` and, globally, `ItemInfoProvider`'s `isShiny` (issue #250) — see §4.3. |
| `overlay/src/renderer/src/sprites/ItemSprite.tsx` | `<ItemSprite objectType>` - the shared item-rendering path (§4.2): wraps `Sprite` with the hover item/enchant tooltip and resolves the shiny badge itself (§4.3). |
| `overlay/src/renderer/src/items/ItemInfoProvider.tsx` | Ingests the `itemInfo`/`enchantNames` envelopes plus `lootBagTypes`'s `shinyItemTypes` field; provides item metadata, enchant-name lookups, and a global `isShiny` (§4.2/§4.3). |
| `overlay/src/renderer/src/items/context.ts` | `ItemInfoContext` + `useItemInfo()` hook. |
| `overlay/src/renderer/src/items/enchantDecode.ts` | Client-side six-bit/base64url decode of an equipped slot's raw `UNIQUE_DATA_STRING` into enchant ids. |
| `overlay/src/renderer/src/items/types.ts` | Wire shapes of the `itemInfo`/`enchantNames` envelopes. |
| `overlay/src/renderer/src/dps/DpsTracker.ts` | Framework-agnostic class ingesting packets → `DpsSnapshot`; owns the `DpsRateRecorder` (§5.2) and retains a session-scoped per-instance damage history (§5.1). |
| `overlay/src/renderer/src/dps/DpsRateRecorder.ts` | Time-binned rate recorder (§5.2): delta-diffs bridge `dps` snapshots into the sparkline's aggregate series + per-(enemy, player) avg/peak folds. |
| `overlay/src/renderer/src/dps/dpsFeed.ts` | `DpsFeed` — the app's single shared `DpsTracker` + post-ingest listener fan-out (§5's "One shared tracker"). React-free. |
| `overlay/src/renderer/src/dps/dpsFeedContext.ts` | `DpsFeedContext` / `useDpsFeed()`. |
| `overlay/src/renderer/src/dps/DpsFeedProvider.tsx` | Owns the `DpsFeed`, wires it to `onPacketBatch`/`onOverlayDetach`; mounted once at App level (and in the harness's `PanelMount`). |
| `overlay/src/renderer/src/dps/useDpsTracker.ts` | Live-snapshot view over the shared feed (event-driven on bridge `dps` packets + 1 s fallback recompute). |
| `overlay/src/renderer/src/dps/useDpsHistory.ts` | History view over the shared feed; exposes `DpsHistoryEntry[]` (backfills on mount). |
| `overlay/src/renderer/src/dps/useDpsGraph.ts` | Sparkline data view: re-reads the recorder's aggregate series immediately on every `dps` envelope (mirrors `useDpsTracker`'s event-driven pattern - issue #259), plus a `BIN_MS` interval so the line still decays when the packet stream goes quiet; skips re-renders while flat at zero. |
| `overlay/src/renderer/src/dps/dpsDetailContext.ts` | `DpsDetailSelectionContext` / `useDpsDetailSelection()` - the selected `DpsHistoryEntry` the `dpsDetail` panel renders (§2's "Programmatic panel spawn/close"). |
| `overlay/src/renderer/src/dps/DpsDetailSelectionProvider.tsx` | Owns the selection state for the context above; mounted once in `App`. |
| `overlay/src/renderer/src/dps/types.ts` | Packet-field shapes the tracker reads. |
| `overlay/src/renderer/src/loot/LootTracker.ts` | Framework-agnostic class ingesting packets → a session-scoped log of bags that dropped near the player (tracked-bag-type set is a constructor parameter, default `[6, 8]`), incl. per-item enchants + `onEntry` subscription (§7). |
| `overlay/src/renderer/src/loot/useLootTracker.ts` | React hook wrapping `LootTracker` (event-driven on `onPacketBatch`, re-renders only when `ingest` reports a change). |
| `overlay/src/renderer/src/loot/types.ts` | Packet-field shapes the loot tracker reads, incl. the synthetic `lootBagTypes` envelope. |
| `overlay/src/renderer/src/harness/*` | The browser renderer harness (no Electron) - dev-flag-gated, out of the production bundle. See `docs/overlay-harness.md`. |
| `overlay/src/renderer/src/alerts/AlertEngine.ts` | Framework-agnostic notification engine (issue #218) - owns a wide (all-color) `LootTracker`, dispatches matched events into `store`. See `docs/notifications.md`. |
| `overlay/src/renderer/src/alerts/{types,catalog,dispatcher,store}.ts` | The engine's React-free core: event/rule types, the `whiteBag`/`orangeBag`/`enchantedDrop` catalog, multi-match dispatch, the bounded fired-alert log. |
| `overlay/src/renderer/src/alerts/useAlertEngine.ts` | React hook mounting one `AlertEngine` at App level (§8), wiring packet/settings/detach IPC. |
| `overlay/src/renderer/src/alerts/slotTypeNames.ts` | SlotType id → display name, empirically derived from the facts file. |
| `overlay/src/renderer/src/alerts/alertStoreContext.ts` | `AlertStoreContext`/`useAlertStore()` (issue #220) - exposes `AlertEngine.store` to panels mounted under `PanelCanvas`, with no direct parent/child relationship to `App.tsx`. |
| `overlay/src/renderer/src/alerts/AlertSettings.tsx` | `NotificationsSettingsView` (issue #221) - the Notifications panel's `PanelSpec.settings` component; the per-panel gear's first user. See `docs/notifications.md`. |
| `overlay/src/renderer/src/alerts/settingsRows.ts` | `buildRuleRows()` - React-free: one row per catalog entry, resolved settings included, for `AlertSettings.tsx` to map over. |
| `overlay/src/renderer/src/alerts/paramsEditors.ts` | `PARAMS_EDITORS` - UI-side `kindId → ComponentType` registry (only imports pre-built editor components itself, same `react-refresh/only-export-components` rationale as `registry.ts`). |
| `overlay/src/renderer/src/alerts/paramsEditorTypes.ts` | `ParamsEditorProps` - shared type only, so `paramsEditors.ts` and an editor component need no value import from each other. |
| `overlay/src/renderer/src/alerts/EnchantedDropParamsEditor.tsx` | `enchantedDrop`'s params editor (tier + SlotType-category + item-name override rows) - registered in `paramsEditors.ts`. |
| `overlay/src/renderer/src/alerts/useItemNameCatalog.ts` | Every distinct name from the bridge's `lootBagTypes` envelope, for the item-name-override autocomplete - a standalone subscription, not routed through `AlertEngine`. Mounts late (with the settings view), so it requests `replayMetadata()` on mount (issue #245). |

---

## 1. Bootstrap & data intake

`main.tsx` is tiny: it installs console capture, then (async, so it can
dynamically import the harness first when needed - see below) renders **one
of two top-level components** by URL hash:

```
window.location.hash === '#config'  →  <ConfigWindow/>   (the settings window)
otherwise                           →  <App/>            (the HUD overlay)
```

Both run in the same bundle; the main process opens the config window with
`#config` appended. Everything else in this doc is the `<App/>` tree.

Before that render, `main.tsx`'s `bootstrap()` checks one thing: if
`window.overlay` is undefined **and** `import.meta.env.VITE_HARNESS` is set,
it dynamically imports `harness/mount.tsx` and lets it install a
non-Electron `window.overlay` shim (and, for the `?panel=` mount mode, render
directly instead of `<App/>`). Neither side of that check is ever true in a
packaged build (`window.overlay` always exists there, and `VITE_HARNESS` is
never defined for the electron-vite build), so this branch - and everything
under `harness/` it imports - is dead code Rollup strips entirely; see
`docs/overlay-harness.md` for the harness itself.

### The preload bridge is the only data source

The renderer never touches Electron, sockets, or files directly. Its **entire**
window onto the outside world is `window.overlay`: an `OverlayApi`
(`overlay/src/shared/overlayApi.ts` - extracted as an explicit interface, not
just `typeof` the preload's object literal, precisely so the harness shim can
implement the same contract without importing anything Electron-specific) the
preload's `contextBridge.exposeInMainWorld('overlay', …)` publishes in
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
> coordinated. The preload side (`preload/index.ts`) fans a single
> `ipcRenderer` subscription out to every registered listener and can suspend
> that fan-out via `window.overlay.setPacketBatchSuspended(true)` — batches
> keep arriving from the bridge but are buffered (not dropped) until delivery
> resumes, when they're merged into one combined batch and delivered once.
> `PanelFrame` calls this for the duration of a drag, so panel content
> (DPS/loot/entity-registry re-renders) doesn't compete with the drag for the
> main thread — see "Drag / reposition" below.

A `PacketEnvelope` is `{ type, direction, time, data }` (`overlay/src/shared/ipc.ts:61-66`),
with `data: unknown` — each consumer casts `data` to its own field shape. The
stream carries both **real game packets** (`UpdatePacket`, `DamagePacket`, …) and
**synthetic envelopes** the Java bridge injects: `type:"dps"` (the computed DPS
snapshot), `type:"objectNames"` (enemy names), `type:"lootBagTypes"` (BagType
6/8 item categorization for the Loot panel, §7), `type:"itemInfo"` (item
name/tier/class/description/damage), and `type:"enchantNames"` (enchant
id→name) — the latter two feed the item tooltip, §4.2. Those originate in
`src/main/java/bridge/DpsBroadcaster.java`, `ObjectNames.java`,
`LootBagTypes.java`, `ItemInfo.java`, and `EnchantNames.java`; see
`bridge-server.md` / `dps-engine.md`.

### App shell & window modes (`App.tsx`)

`App` holds three pieces of state and subscribes once in a mount effect
(`App.tsx:24-46`):

| State | Source | Effect |
| --- | --- | --- |
| `status` | `getBridgeStatus()` + `onBridgeStatus` | coloured status dot |
| `interactive` | `onInteractiveChange` | whole-HUD input/visibility mode |
| `showAttachToast` | `onAttachSuccess` (auto-hides after 2500 ms) | "RealmShark attached" toast |

`App` also backfills main-process logs on mount: `getBufferedMainLogs()` replays
lines logged before this window existed, then `onMainLogEntry` streams new ones —
both funnelled through `ingestMainEntry` into the same console buffer (§7).

**Interactive mode** is the central UX toggle (driven from the main process by
the global hotkey). When `interactive` (`App.tsx:67-93`):

- a `bg-scrim` backdrop dims the game (rendered only in interactive mode);
- every panel is shown and draggable.

When **not** interactive, only *pinned* panels remain, rendered display-only
(`pointer-events-none`). Crucially, `<PanelCanvas/>` is **always mounted**
(never conditionally rendered) so panels keep their live state — the packet
counter, the whole DPS session — across interactive toggles (`App.tsx:87-93`).
`<SpriteProvider>`, `<EntityRegistryProvider>`, and `<ItemInfoProvider>` wrap
the shell so every panel shares one sprite cache, one entity registry, and one
item-info/enchant-name table (§4.2); innermost, an `<InteractiveContext.Provider
value={interactive}>` re-exposes the same `interactive` boolean already
threaded down as an explicit prop, as a context, so a component that isn't a
panel-tree prop-drilling participant (`Tooltip`, §4.2) can still read it.

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
explicit pixel width/height per preset (`registry.ts`'s `PANEL_REGISTRY`), e.g.
Character is a literal `160×100 / 220×130 / 280×170`. The DPS panel's height is instead
*derived* rather than literal: `dpsPanelHeight(size)`
(`dps/rowLayout.ts`) computes the pixel height needed to fit
`DPS_MAX_ROWS[size]` rows (plus the target header and pinned local-player row)
without internal scrolling, currently `200×106 / 300×178 / 380×334`. Any
change to `DPS_MAX_ROWS`/`DPS_ROW_SPRITE_SIZE` or the row markup in
`DpsList.tsx` must keep `dpsPanelHeight`'s constants (row gap, header height,
frame chrome) in sync, since registry sizes are static and can't be measured
from the live DOM. The size button cycles
`sm → md → lg → sm` via `SIZE_CYCLE` (`PanelFrame.tsx:6`, exported and reused by
`PanelCanvas.tsx:111`). Panels never store pixel dimensions — only the preset
key — so retuning a size means editing the registry, and it applies to every
saved layout.

`panelStyle` (`anchor.ts:38-53`) turns `(anchor, targetSizePx, canvasSizePx)`
into CSS: `top/left` in `%`, and `width/height` in **px capped** so the panel
can't run past the window's right/bottom edge:

```
width  = min(targetPx.width,  ((100 - anchor.x)/100) * canvasWidth)
height = min(targetPx.height, ((100 - anchor.y)/100) * canvasHeight)
```

**The window-shrink case is the only thing this cap is for**, and dragging
cannot reach it: `anchorFromPointer` bounds a dragged anchor to the range
where the preset still fits (below), so the cap returns the preset size
verbatim for every anchor a drag can produce. It bites only when a *saved*
anchor no longer fits because the game window shrank under it.

That separation is load-bearing for drag performance, not cosmetics — see
"Per-frame cost during the move" below. The cap compares within a 0.01 px
slack (`FIT_EPSILON_PX`), because the anchor bound is a percentage and the
cap re-derives pixels from it: an exact-fit round trip lands ~1e-13 px short
in floating point, and without the slack a flush panel would render a hair
narrower than its preset (at a fractional, blurrier width).

### Drag / reposition

Dragging is manual (no library). `PanelFrame.startDrag` (`PanelFrame.tsx:35`)
records the grab offset within the panel (so the panel doesn't snap its corner
to the cursor), then attaches window `mousemove`/`mouseup` listeners. Each move
calls `anchorFromPointer` to convert `(clientX - grabOffset)` into a **clamped
anchor** — clamped to `0 … (canvas - panel)/canvas`, i.e. the range where the
panel still fits whole, so a drag stops flush with the right/bottom edge
rather than walking its corner off-screen — and writes the resulting position
**directly to the frame's DOM** — *not* through React state. Routing every pointer event
through `setPanels` instead would re-render `PanelCanvas` and every panel's
(sprite-rendering) content 60-125×/sec, which is what made dragging lag (#120).
The final anchor is committed to state once, on `mouseup`, via `onDrag` →
`updatePanel(id, { anchor:{ pos:'tl', x, y } })` (`PanelCanvas.tsx:108`) — that
persists the move and triggers the debounced save below. `PanelCanvas` never
re-renders during the move phase, so the direct DOM writes can't be clobbered
by a reconcile, and the commit reasserts the identical position (no drop jump).
Only the drag handle (the title bar) starts a drag, and only when
`interactive`. The pin/size buttons `stopPropagation` on `mousedown` so
clicking them never begins a drag (`PanelFrame.tsx:98,110`). Clicking anywhere on
a panel raises it via `onBringToTop`, which bumps `zIndex` to `max+1`
(`PanelCanvas.tsx:89-94`).

**Per-frame cost during the move.** `left`/`top` stay at their rest values for
the whole drag; position is applied via `transform: translate3d(...)` instead
(a compositor-only property — no layout/repaint — unlike rewriting `left`/`top`
every frame, which forces a full layout + repaint). `width`/`height` are not
written at all: the anchor clamp above guarantees `panelStyle` returns the
same preset size for every anchor the drag can reach, so `transform` is the
*only* per-frame write and the move is compositor-only by construction.

> This was a real regression, not a hypothetical. `anchorFromPointer`
> originally clamped to a bare 0-100 %, which let a drag walk the corner into
> the region where `panelStyle`'s cap fires — so the size changed on *every*
> mousemove, and each change was a full layout + repaint of the panel
> subtree. The dead zone is as large as the panel, so the cost scaled with
> panel size: measured on a 1280x900 canvas, dragging `dpsDetail` (620x560,
> the largest preset and the only panel spawned at `lg`) through the
> bottom-right rewrote its size on 60 of 60 moves for 34.8 ms of layout +
> 30.9 ms of paint, versus 6.0/2.3 ms for the identical drag in the
> unclamped region — and squashed the panel to 440x268 as it went. `console`
> (380x220) hit it on 20 of 60 moves. After the fix all four cases sit at
> 0 size writes and ~6/2 ms. Regression test:
> `overlay/test/anchor-dragClamp.test.ts`. On top of that, `document.documentElement` gets the `panel-dragging`
class for the drag's duration, which suspends every panel's `backdrop-filter`
blur + `box-shadow` (`main.css`) — hardware acceleration is off (required for
overlay transparency, Electron #25153), so blur/shadow is otherwise
recomposited on the CPU every frame a panel moves, which measured (#132) as
the dominant per-frame cost. `window.overlay.setPacketBatchSuspended(true)` is
also called for the drag's duration, so panel content isn't independently
re-rendering off the packet stream at the same time (see the fan-out note
above). `dragPerf.ts`'s `startDragPerf`/`stop` bracket every drag and, when
the module's `DRAG_PERF_DEBUG` const is flipped to `true` (mirroring
`DPS_DEBUG` in `DpsTracker.ts` — off by default, so a normal drag logs
nothing), log a `[drag-perf]` frame-cadence summary to the Console panel, for
catching a future regression in drag smoothness.

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

Both the load and the debounced save filter through `isPersistablePanel`
first, dropping any panel whose registry entry sets `ephemeral` — see §2's
"Programmatic panel spawn/close" for why a spawned panel like `dpsDetail`
must never round-trip through `panels.json`. (This used to key on `closable`
back when `dpsDetail` was the only closable panel; since the closeable-panels
change made every panel except status closable — with closing = set
`PanelInstance.hidden`, not remove — ordinary closed panels must keep
persisting so the hidden flag survives a restart. See §2's "Closeable
panels".)

The main process persists `panels.json`; see `overlay-main-process.md`.

### The `PanelContentProps` contract

Every panel body is a `ComponentType<PanelContentProps>` and receives exactly one
prop: `{ size: PanelSize }` (`registry.ts`'s `PanelContentProps`). Panels **do not** receive the
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
2. **Register it** in `PANEL_REGISTRY` (`registry.ts`): add a key with
   `{ type, title, sizes: { sm, md, lg }, component: FooPanel, closable: true }`.
   The three `sizes` entries are required (they're the only dimensions the panel
   will ever have); `closable` is the norm for every singleton panel (§2's
   "Closeable panels" — only `status` omits it), and the Status panel's toggle
   list picks the new type up automatically from the registry.
3. **Add a default instance** in `defaultLayout()` (`PanelCanvas.tsx:13-33`) with
   a unique `id`, a non-overlapping `anchor`, a `size`, and a `zIndex`. Thanks to
   `mergeWithDefaults`, existing users pick it up on upgrade.
4. Nothing else — `PanelCanvas` renders any panel whose `type` has a registry
   entry and silently skips unknown types (`PanelCanvas.tsx:99-100`), so a stale
   saved panel referencing a removed type won't crash.

### Programmatic panel spawn/close (issue #194)

Every panel in `defaultLayout()` is always present; nothing before issue #194
let one panel body open *another* panel on demand. The DPS summary/detail
split needed exactly that — clicking a session in the small `DpsSummaryPanel`
opens its per-enemy/per-player breakdown in a separate, much larger,
independently draggable/resizable `dpsDetail` panel instead of swapping the
summary panel's own cramped content in place — so this is now a small generic
mechanism any future panel can reuse, not a DPS-specific hack:

- **`panels/panelSpawn.ts`** — `PanelSpawnContext` / `usePanelSpawn()`, giving
  a panel body three calls: `openPanel(id, type, size?)` (creates a
  `PanelInstance` at a fixed default anchor if `id` isn't already in the
  canvas's `panels` array, otherwise un-hides it if closed and raises the
  existing one to front — so re-targeting an already-open panel, e.g.
  selecting a different session, never spawns a duplicate), `closePanel(id)`
  (removes an `ephemeral` panel from the array entirely; hides any other —
  see "Closeable panels" below), and `isOpen(id)` (whether a panel with that
  `id` is currently on the canvas and not hidden — lets a spawning panel body
  derive UI state, like a row highlight or the Status panel's toggle states,
  from the panel's actual open/closed state instead of tracking it
  separately). All three are implemented by `PanelCanvas` as thin `setPanels`
  wrappers over `panelLayout.ts`'s pure `withPanelOpen`/`withPanelClosed`/
  `isPanelOpen` transitions and provided via `<PanelSpawnContext.Provider>`
  wrapping its rendered panels — `PanelCanvas` itself has no DPS-specific
  knowledge; it only manipulates `PanelInstance[]` generically.
- **`registry.ts`'s `closable?: boolean`** on a `PanelSpec` — when set,
  `PanelFrame` renders a ✕ button in that panel's title bar (alongside
  pin/size) wired to `usePanelSpawn().closePanel(panel.id)` via the `onClose`
  prop `PanelCanvas` passes every `PanelFrame`. Since the closeable-panels
  change, every panel except `status` sets it — see "Closeable panels" below
  for why status must stay un-closeable.
- **A spawned (`ephemeral`) panel is not in `defaultLayout()`** and is never
  added by `mergeWithDefaults` — it only exists in the `panels` array while
  open, so closing it and reopening later always respawns at
  `panelLayout.ts`'s `SPAWN_ANCHOR` default position rather than resuming
  wherever it was last dragged. This was a deliberate simplicity tradeoff
  (position isn't preserved across a close/reopen cycle), not a limitation of
  the mechanism itself.
- **`ephemeral` panels are excluded from persistence, in both directions.**
  `PanelCanvas`'s `isPersistablePanel` filters any panel whose registry entry
  sets `ephemeral` out of `savePanelLayout`'s payload, and out of a freshly
  loaded `panels.json` before it's merged with defaults. Without this, a
  spawned `dpsDetail` panel open at quit time would round-trip into
  `panels.json` like any ordinary panel and reappear on next launch — but its
  selection lives in the separate, non-persisted `DpsDetailSelectionContext`
  (below), which always starts `null`, so the restored panel would show a
  permanent "No session selected" empty state with no way for the user to
  populate it short of closing and reopening it. The load-side filter also
  guards against a `panels.json` written before this fix (or by an older
  build) still carrying a stale spawned panel. This is what keeps the "only
  exists in the `panels` array while open" claim above actually true.
- **Cross-panel data still needs its own channel** — `PanelContentProps` is
  still just `{ size }` (above), so `openPanel`/`closePanel` alone can't tell
  the newly-opened panel *what* to show. The DPS case adds a small dedicated
  context for this: `dps/dpsDetailContext.ts`'s `DpsDetailSelectionContext` /
  `useDpsDetailSelection()` (state owned by
  `dps/DpsDetailSelectionProvider.tsx`, mounted once in `App.tsx` alongside
  `SpriteProvider`/`EntityRegistryProvider`/`ItemInfoProvider`) holds the
  currently-selected `DpsHistoryEntry`. `DpsSummaryPanel`'s row click calls
  both `select(entry)` (this context) and `openPanel('dpsDetail', 'dpsDetail',
  'lg')` (the generic mechanism above); `DpsDetailPanel` reads `selected` back
  out. A future panel needing the same shape (spawn + pass data) would add its
  own equally small context rather than generalizing this one — the DPS
  selection context has nothing panel-spawning-specific in it, and forcing a
  shared generic payload type across unrelated features isn't worth the
  indirection for a single consumer. `selected` is never explicitly cleared
  on close — `DpsSummaryPanel`'s row highlight instead gates on
  `usePanelSpawn().isOpen('dpsDetail')`, so it reads the canvas's actual
  open/closed state rather than a copy that has to be manually kept in sync.
  An earlier version tore down `selected` from `DpsDetailPanel`'s
  unmount-only `useEffect` cleanup, but that's unsafe under React
  StrictMode: on mount, StrictMode runs setup → cleanup → setup in
  development, so the cleanup fired once immediately after the very first
  mount and wiped the selection that had just been set, and the panel opened
  showing "No session selected" until a second click. `isOpen()` has no such
  lifecycle dependency.
- **The harness mount (`harness/PanelMount.tsx`)** has no `PanelCanvas`, so it
  wraps its single rendered panel in a no-op `PanelSpawnContext.Provider`
  (`openPanel`/`closePanel` both no-ops) purely so `usePanelSpawn()` doesn't
  throw — nothing in a static `npm run shots` screenshot ever calls it. It
  also wraps in `DpsDetailSelectionProvider` and, only for the `dpsDetail`
  type, mounts a small `AutoSelectFirstDpsSession` helper that auto-selects
  the first retained history entry once the `gallery` fixture has produced
  one — needed because nothing in the harness simulates the row click that
  would normally populate the selection, and an unselected `dpsDetail` shot
  would otherwise just show its "No session selected" empty state instead of
  real per-enemy/per-player content.

### Closeable panels & the Status panel's toggle list

Every panel except `status` is `closable` — the title-bar ✕ on a singleton
panel doesn't remove its instance the way it does for the `ephemeral`
`dpsDetail`; it sets `PanelInstance.hidden` and keeps the instance in the
array (`panelLayout.ts`'s `withPanelClosed`). `PanelCanvas` skips hidden
panels at render (same guard as unknown types), and because hidden singletons
still persist to `panels.json`, both the closed state *and* the panel's
position/size/pin survive a restart — toggling a panel back on restores it
exactly where it was, not at a spawn anchor.

The way back on is the **Status panel's "Panels" toggle list**
(`StatusPanel.tsx`, md/lg sizes): one ghost-button chip per singleton panel
(everything in the registry except `status` itself and `ephemeral` types —
an empty `dpsDetail` toggled on from there would be meaningless), rendered
green when shown / faint when hidden via the same `Button` ghost+`active`
styling as the pin toggle. Each chip reads `usePanelSpawn().isOpen(type)` and
flips via `closePanel(type)` / `openPanel(type, type)` — singleton panels use
`id === type` (the `defaultLayout()` invariant), so the registry key doubles
as the instance id. Because chips derive from the same `panels` array the ✕
buttons mutate, a panel closed from its own title bar reads as toggled-off on
the Status panel with no separate state to sync.

Two invariants this feature leans on:

- **`status` must never be closable** — it hosts the only affordance that
  un-hides other panels; a closeable status panel could strand the user with
  everything toggled off and no way back short of deleting `panels.json`.
- **`isPersistablePanel` keys on `ephemeral`, not `closable`** — closed
  singletons must keep round-tripping through `panels.json` or they'd be
  silently resurrected by `mergeWithDefaults` on next launch (its append-
  missing-defaults step only skips ids that are still present in the saved
  array, hidden or not).

`StatusPanel` reads `PANEL_REGISTRY` for the chip list even though
`registry.ts` imports `StatusPanel` — a deliberate module cycle, safe only
because the registry is read at render time (inside `togglablePanels()`),
never during module evaluation; a module-scope read would hit the cycle
before the registry const initializes.

### Per-panel settings gear (issue #221)

A second small generic mechanism alongside spawn/close above, for the
opposite direction: instead of one panel opening *another*, a panel flips
its *own* body in place to a settings view. `docs/prd-notifications.md` §5
introduced it as a cross-cutting mechanism (future users: the Loot panel's
bag-type filter, the DPS panel's column config), with the Notifications
panel's settings view (`docs/notifications.md`) as its first, proving user.

- **`registry.ts`'s `settings?: ComponentType<PanelSettingsProps>`** on
  `PanelSpec`, alongside `component`. `PanelSettingsProps` is `{ onDone: ()
  => void }` — no `size`, unlike `PanelContentProps`: a settings form is read
  top-to-bottom, not glanced at, so it doesn't scale its own content by
  preset the way a content body does. Omitting `settings` (every panel but
  `notifications` today) means no gear at all — there is no separate
  opt-out flag to forget.
- **`PanelFrame.tsx`** renders a gear button in the title bar (interactive
  mode only, alongside pin/size/close) iff `spec.settings` is set, and holds
  one frame-local `showSettings` boolean (`useState`, not lifted to
  `PanelCanvas` — this is purely this panel's own display mode, nothing else
  needs to know). Clicking the gear toggles it; the body then renders
  `<spec.settings onDone={() => setShowSettings(false)}/>` in place of
  `<spec.component size={panel.size}/>` when true. The settings view can
  additionally call `onDone` itself (e.g. a "Done" button at the bottom of
  its own form) to flip back without requiring the user to find the gear
  again — both paths land on the same toggle. `showSettings` persists across
  an `interactive` toggle exactly like `pinned`/`size` do (§2 above: panels
  keep their live state across toggles) — the gear itself is only reachable
  while interactive, so a stale `true` value can only mean the user
  themselves last left the panel flipped open.
- **Dragging/pin/size/close all keep working while flipped** — flipping only
  swaps which component renders inside the content wrapper; none of
  `PanelFrame`'s chrome (title bar, drag handling, the size-cycle/pin/close
  buttons) is aware of `showSettings` at all.
- **A settings view owns its own storage.** Unlike `PanelContentProps`
  consumers, which read live data via `window.overlay.on…`/shared contexts,
  a settings view is expected to read *and write* — `NotificationsSettingsView`
  (`docs/notifications.md`) is the reference implementation: it loads via
  `getSettings()`, edits its own slice of `OverlaySettings`, and saves
  (debounced) via `saveSettings()` on every change — no new IPC surface, no
  Save button (PRD §5 "apply on change").
- **The harness (`harness/PanelMount.tsx`, `harness/mount.tsx`)** gained a
  `&settings=1` query flag mirroring the gear flip statically: it renders
  `spec.settings` (with a no-op `onDone`, since there's no click to simulate
  in a frozen shot) instead of `spec.component`. `npm run shots`
  (`docs/overlay-harness.md`) picks this up automatically for any panel type
  whose `spec.settings` is defined, alongside its normal per-panel loop —
  `<type>-<size>-settings.png`, with the same below-the-fold `-full` variant
  treatment as ordinary panel content.

---

## 3. The panels

All ten bodies are thin; the data lives in the shared services. `size` maps
to per-panel scale tables at the top of each file. Every gear/loot icon below
renders through `ItemSprite`, not `Sprite` directly, so it's hoverable for the
item tooltip (§4.2) with no per-panel wiring.

| Panel | Title | Data source | Notes |
| --- | --- | --- | --- |
| `StatusPanel` | "RealmShark" | `window.overlay.*` directly | Connection dot, hotkey hint, packet count, JS heap MB, app version + **auto-update** UI, plus the **"Panels" toggle list** (§2's "Closeable panels") — the one panel with no title-bar ✕. |
| `DpsPanel` | "DPS" | `useDpsTracker()` → `<DpsList>` | Rows per attacker vs. the focused enemy, ranked by cumulative damage (§5). `MAX_ROWS = {sm:2, md:3, lg:6}` — deliberately few, large rows (24-40px sprites) so the panel reads at a glance mid-fight, rather than the previous 3/6/12 dense layout. Each row also renders that attacker's dyed `CharacterSprite` + equip-slot icons (gear hidden at `sm`), resolved from `EntityRegistry` by `row.objectId`, plus a damage-share bar (length **and** color both encode `damage/topDamage`) and a rank badge/ring on the local player's row (§6). The numeric readout only — the trend graph is a separate panel (below). |
| `DpsGraphPanel` | "DPS Graph" | `<DpsSparkline>` (owns `useDpsGraph()` itself) | Standalone, closable, independently placeable/sizable panel (issue #259) over the same aggregate series the DPS panel used to embed at md/lg — see §5.2's "The sparkline". Shown and sized at every preset, including `sm`. |
| `ConsolePanel` | "Console" | `consoleLog.ts` buffer | Live log with search (Ctrl/Cmd+F), level colours, clear. |
| `CharacterPanel` | "Character" | `EntityRegistry` (local player) | Big dyed sprite + 4 equip icons + username. |
| `InstancePanel` | "Instance" | `EntityRegistry.characters()` | Every named player in the instance, dyed sprites + gear. |
| `DpsSummaryPanel` | "DPS Summary" | `useDpsHistory()` | A master list only: retained past instances (icon + name + a "You: Xdmg (#rank)" headline). Clicking a row opens that instance's breakdown in the separate `dpsDetail` panel below rather than swapping this panel's own content — see §2's "Programmatic panel spawn/close" and §5.1. |
| `DpsDetailPanel` | "DPS Detail" | `useDpsDetailSelection()` | The large, closable, independently draggable/resizable panel `DpsSummaryPanel` opens on row click (issue #194): the selected instance's enemies ranked by total damage, expandable to a frozen per-player breakdown (gear/dyes/enchants). A single reused panel instance re-targeted on each new selection, not one spawned per session. Renders "No session selected" if opened with nothing selected (shouldn't happen via the normal row-click path). See §2, §5.1. |
| `LootPanel` | "Loot" | `useLootTracker()` | Session log of white/orange bags (BagType 6/8) that dropped near the player, both always shown under their own bag sprite + count (no text label), with per-item rarity border + shiny badge + enchant tooltip, chronological (not de-duplicated). See §7. |
| `NotificationsPanel` | "Notifications" | `useAlertStore()` | Session log of fired alerts (issue #220), newest first: time, payload icon (`ItemSprite`, when set), title/body, matched catalog kind ids (hidden at `sm`). A pure viewer over the same `FiredAlertStore` `AlertToastHost` reads - see §8/`docs/notifications.md`. The only panel with a settings gear today (issue #221, `AlertSettings.tsx` - §2's "Per-panel settings gear"). |

**StatusPanel** (`panels/StatusPanel.tsx`) is the only panel wired straight to
the IPC surface rather than a shared service. It subscribes to `onBridgeStatus`,
`onPacketBatch` (just to count: `packetCount += packets.length`, `StatusPanel.tsx:42-45`),
`onUpdateAvailable`, and `onUpdateProgress`, and polls `performance.memory`
(a non-standard Chrome/Electron field, guarded, `StatusPanel.tsx:14-22`) every
1 s. It also hosts the updater UI (Check / Update & restart), plus "Report bug",
"Capture now" (`build-and-release.md`), and "Chat probe" — the toggle for the
local chat/party wire-shape diagnostic (`docs/overlay-main-process.md` "Chat
probe"; renders amber with a live captured-count while armed, polled via
`getChatProbeStatus` once per second only in that state). Content beyond the
header is gated
on `size !== 'sm'`, and the last-packet line only on `size === 'lg'` — `sm`
(160×50) stays a bare status glance with no actions at all, by design (#179).
At `md`/`lg` the actions render as a single row of compact (`size="xs"`)
buttons **pinned to the panel's bottom edge** (`mt-auto`) so they're always
reachable without scrolling, regardless of how much info renders above them;
their status feedback shares one `actionMsg` line below the row instead of a
message per button, to keep that row's height fixed; each handler sets
`actionMsg` itself, so the latest action fired always wins rather than an
older message masking a newer one. `registry.ts`'s `md` height was grown (155px → 184px,
`lg` unchanged at 195px) to fit this row with the tightened info-row spacing
above it — see issue #179 for the before/after gallery shots.

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
`applyPack` clears the crop + bake caches, then **decodes each atlas PNG once**
asynchronously with
`createImageBitmap(blob, { colorSpaceConversion:'none', premultiplyAlpha:'none' })`
(`SpriteProvider.tsx:53-59`) — raw decode so sampled pixels match the game's exact
RGBA (a plain `<img>` decode applies ICC/gamma + premultiply rounding). Decoded
bitmaps go in `atlasesRef`; a `setGen` bump (`SpriteProvider.tsx:69`) re-renders
consumers so a sprite that returned `null` before its atlas finished decoding is
retried.

`getSprite(objectType, size)` (`SpriteProvider.tsx:217-249`): look up the current frame's rect (from
`pack.animTable[objectType]` for an animated idle sprite, else `pack.table[objectType]`)
→ `[atlasId,x,y,w,h]`, crop it to an `ImageData` at native resolution, scale
that up to `size×size` with `imageSmoothingEnabled=false` (nearest-neighbour,
preserving the pixel-art look) and bake in a 1-pixel black silhouette outline
at that display resolution (`outline.ts`'s `outlineAtDisplaySize` — see
"Silhouette outline" below), then `canvas.putImageData` the result and return
`canvas.toDataURL()`, memoised by `"objectType:size:frame"`. Returns `null`
when the pack isn't ready, the objectType is absent, or the atlas hasn't
decoded yet.

`getDyedSprite(baseType, size, clothingDye?, accessoryDye?)`
(`SpriteProvider.tsx:278-431`) composites clothing/accessory dyes onto a character
sprite using the pack's `maskTable` + `dyeTable`. The full compositing model
(mask channels = region + shade, textile sub-pixel tiling via `TEXTILE_SUB=5`,
solid vs. textile `dyeTable` encoding) is documented in **`dyes-and-textiles.md`**
— not repeated here. Key contract: it **falls back to `getSprite`** when the pack
isn't ready, there's no dye, or the base type has no mask, and memoises by
`"dye:baseType:size:clothingDye:accessoryDye:baseFrame:clothingFrame:accessoryFrame"`
(the base frame only varies for an animated idle character; the dye frames only
vary for animated textiles — see `dyes-and-textiles.md`).

**Silhouette outline (`sprites/outline.ts`).** Every sprite drawn through this
path gets RotMG's thin black outline hugging its opaque silhouette, baked in at
crop/bake time (never recomputed per frame) — ports the same padded-dilation
approach the Swing desktop client uses (`assets/ImageBuffer.java`'s
`getOutlinedIcon`; see `asset-pipeline.md`). `outlineImageData(src, thickness)`
pads an `ImageData` by `thickness` transparent pixels on every side, then
`dilateSilhouette` grows the opaque region into that padding (`thickness`
passes of 4-neighbour dilation) and paints newly-opaque pixels solid black —
crisp/aliased, not a blurred glow. `getSprite`/`getDyedSprite` use
`outlineAtDisplaySize`, which scales the composite up to the caller's display
size *first* and only then calls `outlineImageData` with `thickness=1` — this
mirrors `getOutlinedIcon`, which also scales before outlining, so the line
reads as exactly 1 screen pixel regardless of the sprite's native resolution
or how large it's displayed. `bakeDyedSprite` (`dyeBake.ts`) can't do that: its
output is scaled to display size every *frame* by `renderDyeFrame` via a
single canvas draw with no pixel readback, so it instead calls
`dilateSilhouette` directly with a flat `thickness=1` on its own pre-padded
buffer, in its (SUB-subdivided) composite resolution — thinner than a true
1-screen-pixel line at large
display sizes, but not blown up by `SUB` the way outlining at native
resolution would be (see `dyes-and-textiles.md`'s "Sprite outline"). The
outline shares the crop/bake caches, so cache entry counts and per-frame cost
are unaffected; it composes with — sits *inside* — the CSS `ring` rarity
border `Sprite.tsx` applies around the `<img>`/`<canvas>` element.

Both functions (plus `isAnimated`/`frameMs`) are exposed via `SpriteContext` (`context.ts:6-37`); panels call
them through `useSprites()` or the `<Sprite>` component.

**Cache bounding (`sprites/lruCache.ts`).** Both memo caches — the crop/dye
data-URL cache and the animated-textile bake cache — are `LruCache`s, not plain
`Map`s (`SpriteProvider.tsx` `CROP_CACHE_MAX=2048` / `BAKE_CACHE_MAX=256`). Their
keys are combinatorial (`objectType × size × dye × enchant × frame`), so an
unbounded `Map` grew monotonically with every distinct player loadout seen — the
renderer heap's dominant leak over a long session (measured ~9→88 MB over hours).
LRU eviction bounds them: an actively animating sprite keeps re-touching its own
frame keys, so eviction targets loadouts that have left view, not the working
set. They're additionally **cleared on `onOverlayDetach`** (game closed) so a
session's accumulated sprites don't stay resident until the next atlas reload —
already-rendered data-URLs are self-contained strings, so clearing only forces
re-derivation on the next render (the overlay hides on detach anyway); the
decoded `atlasesRef` bitmaps are asset data, kept for the next attach.

### `Sprite` and `CharacterSprite`

`Sprite` (`sprites/Sprite.tsx`) takes an `objectType` (+ optional `size`, dyes,
`rarity`, `shiny`, `className`). It picks `getDyedSprite` when a dye is present
else `getSprite` (`Sprite.tsx:51-53`), and renders an
`<img style={{imageRendering:'pixelated'}}>`. When the lookup returns `null`
(no real pack / undecoded atlas) it renders a **deterministic HSL placeholder
chip** so an unresolved objectType is still a stable coloured box
(`Sprite.tsx:16-19,67-79`). It also ticks its own animation clock:
`isAnimated(objectType, clothingDye, accessoryDye)` (from `SpriteContext`) says
whether this particular sprite has an idle-frame or textile-frame animation,
and only then does a local `setInterval` at `frameMs` re-render it
(`Sprite.tsx:37-45`) — static sprites and event-driven panels never tick.
`rarity` (0-4, see §4.1) and `shiny` (see §4.3) render the game's own **UI
sprites** (issue #205/#206) when available: the tier's `RarityIcon_N` pip in
the sprite's bottom-right corner, and `shiny_item_icon` in its top-left
corner — both resolved via `useSprites().getUiSprite(name)`, which reads
`SpritePack.uiSprites` (a bridge-extracted, pre-cropped data-URL per sprite
name; see `docs/asset-pipeline.md`). When that pack section is unavailable
(a bridge that predates #205, or no game assets — dev/CI/headless) each falls
back to a CSS approximation instead: `rarity` adds a `ring-1
ring-rarity-<tier>` class (`RARITY_RING_CLASS`) on whichever of the three
render paths (canvas/`<img>`/placeholder) is taken, so it never changes the
sprite's rendered layout size the way a `border` would; `shiny` overlays a
small SVG rainbow-star badge (`ShinyBadge`) in the top-left corner instead.
Either way, a wrapper element is only needed for an absolutely-positioned
overlay (the real pip/shiny `<img>`, or the fallback `<svg>` badge) — a
Tailwind ring class needs no wrapper — so `Sprite` only wraps its output in a
`position: relative` span when `shiny` is truthy or a rarity pip is being
drawn, leaving every other caller's DOM shape unchanged. Both the real
sprite and its CSS fallback are sized off the sprite's own display size
(`overlaySize`, `Sprite.tsx`) so swapping between them never shifts layout.

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
`clothingDye`, `accessoryDye`, `enchantSlots[4]`, `name`. The stat ids it reads
(`EntityRegistry.tsx:6-11`):

| Const | StatType # | Meaning |
| --- | --- | --- |
| `SKIN_ID_STAT` | 25 | equipped skin objectType |
| `INVENTORY_0_STAT` (+0..3) | 8-11 | the 4 equipped slots (weapon/ability/armor/ring) |
| `NAME_STAT` | 31 | username string — comma-separated on the wire (`"PlayerName,a0ca,…"`); only the part before the first comma is kept, dropping the trailing title/label cosmetic codes (matches the bridge's `Entity.name()`) |
| `CLOTHING_DYE_STAT` | 32 | Tex1 clothing dye objectType |
| `ACCESSORY_DYE_STAT` | 33 | Tex2 accessory dye objectType |
| `UNIQUE_DATA_STRING_STAT` | 80 | comma-joined weapon/ability/armor/ring encoded enchant strings → `equipmentRarity[4]` (§4.1) and raw `enchantSlots[4]` (§4.2) |

> **Non-obvious fact — stats are deltas, so records are merged, never replaced.**
> `mergeStats` (`EntityRegistry.tsx:108-159`) reads stats from **both**
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
(`EntityRegistry.tsx:77-81`).

> **Two maps, not one — `recordsRef` (live) vs. `lastRecordRef` (last-known).**
> `mergeStats` writes every merged record into *both* `recordsRef` (the live
> roster) and `lastRecordRef` (never pruned). When an objectId appears in
> `UpdatePacket.drops` (the entity left view / the instance), only its
> `recordsRef` entry is deleted — if the local player's own id drops,
> `localPlayerRef` is forgotten too. `lastRecordRef` keeps the same record
> object indefinitely (until the next full `clear()`), so `objectType`,
> `skin`, `equipment`, `equipmentRarity`, `clothingDye`, `accessoryDye`,
> `enchantSlots`, and `name` all keep resolving a dropped entity's *last-seen*
> values instead of `null` — e.g. the DPS list keeps showing a player's actual
> gear/sprite after they leave the instance mid-fight, rather than an empty
> silhouette. `characters()` deliberately reads `recordsRef` only, so the
> *live* instance roster (`InstancePanel`) still drops a player who left. If an
> objectId reappears after a drop (rejoin, or plain id reuse), `mergeStats`
> re-seeds the new record from `lastRecordRef`'s prior entry rather than
> starting blank, so a partial first packet (e.g. `NAME_STAT` only) doesn't
> transiently wipe known equipment.

**`subscribe(cb)`** (`EntityRegistry.tsx:59-64`) lets a panel register a
callback instead of polling. Any batch that contains a display-relevant change
sets a local `changed` flag and calls `scheduleNotify()`
(`EntityRegistry.tsx:66-75`), which coalesces a burst of packets into a single
`requestAnimationFrame` call to every subscriber — see the `CharacterPanel`/
`InstancePanel` callout in §3.

Accessors (`objectType`, `skin`, `equipment`, `equipmentRarity`, `name`,
`clothingDye`, `accessoryDye`, `enchantSlots`, `characters`, `localPlayerId`)
are `useCallback`-stable and read the ref synchronously
(`EntityRegistry.tsx:171-251`) — all but `characters()`/`localPlayerId()` read
`lastRecordRef` (see above), so they resolve for a since-dropped objectId too.
`characters()` returns every *currently live* objectId with a non-empty `name`
— i.e. the instance's present players. `enchantSlots(objectId)` returns the
raw 4-element array (or `null` if this entity has never sent the stat) — see
§4.2 for decoding it.

### 4.1 Enchant rarity borders (`sprites/enchantRarity.ts`, issue #107)

`UNIQUE_DATA_STRING` (StatType #80) already crosses the bridge unfiltered —
`PacketSerializer` reflects every `StatData` field verbatim, with no
stat-type filtering (see `bridge-server.md`'s wire-format notes) — so no
bridge change was needed to get it into the renderer. `enchantRarity.ts` is a
straight TypeScript port of the Java decode already used bridge-side for DPS
math (`bridge.dps.PcStatsDecoder.sixBitStringToBytes` +
`bridge.dps.ParseEnchants.extractEnchantIds`), chosen over adding a synthetic
bridge envelope (the `objectNames`/`lootBagTypes` precedent) specifically so
rarity merges on the same per-objectId timeline `equipment`/`skin`/dyes
already use — it updates from both `UpdatePacket` and `NewTickPacket` deltas
for free, with no extra envelope to keep in sync.

Wire shape: the stat's `stringStatValue` is 4 comma-separated per-slot codes
(weapon/ability/armor/ring, same order as `equipment`/INVENTORY_0..3); each
code is a six-bit-encoded byte blob decoding to a header byte + a `type`
that must equal 1026 + up to 4 enchant ids, terminated by `-3`.
`extractEnchantIds` returns that slot's list of filled enchant ids (skipping
locked/empty markers); `slotRarityTier` is just `min(ids.length, 4)`.

**Rarity derivation and how it was verified.** The tier is the count of an
item's filled enchant slots: 1 = uncommon (green), 2 = rare (blue), 3 =
legendary (purple), 4 = divine (gold); 0 (or no `UNIQUE_DATA_STRING` at all)
renders no border. This matches RotMG Exalt's own in-game enchant-slot border
system (public game knowledge — the client colors an item's border by how
many of its enchant slots are filled, independent of which specific enchants
those are). **This build agent had no game client to verify the rule live
against** (a headless cloud sandbox — see CLAUDE.md's dev-loop constraints);
if a live-game check ever contradicts it, `slotRarityTier` in
`enchantRarity.ts` is the one place to correct. `FakePacketSource`'s
`ROSTER_ENCHANTS` (Java) synthesizes all five outcomes (0 through 4 filled
slots) across the fake roster via `ParseEnchants.encodeEnchantSlot`, so the
tier boundaries are exercised and regression-tested (`ParseEnchantsRarityTest`,
`PcStatsDecoderTest`) even with no game installed.

**Real pip rendering (issue #205/#206).** `enchantRarity.ts` only computes the
tier; how a tier is *drawn* lives in `Sprite.tsx`. `RARITY_PIP_SPRITE_NAME`
(also in `enchantRarity.ts`) maps tier 1-4 to the game's own pip sprite name
(`RarityIcon_1`..`RarityIcon_4`, confirmed against `enchantRarity.ts`'s own
green/blue/purple/gold mapping — see #205's asset table), resolved through
`useSprites().getUiSprite(name)` against the bridge's `uiSprites` pack
section and rendered as a small `<img>` in the sprite's bottom-right corner.
Tier 0 has no pip name and renders nothing. When `uiSprites` is unavailable
(the bridge predates #205, or has no game assets — always true in this
headless dev sandbox), `Sprite` falls back to the `RARITY_RING_CLASS` ring
described above, so dev/soak screenshots still convey rarity.

### 4.2 The item tooltip — `ItemSprite`, `ItemInfoProvider`, `Tooltip` (issue #109)

Every item sprite in the overlay — `GearRow`'s 4 equipped slots and the Loot
panel's pickup icons (§7) — renders through **`ItemSprite`**
(`sprites/ItemSprite.tsx`), not `Sprite` directly: it wraps `<Sprite
objectType size>` with a hover tooltip, so any current or future
item-rendering panel gets the tooltip for free by using `ItemSprite`/`GearRow`
instead of `Sprite`.

- **Item info** (name/tier/class/description/damage) comes from
  `useItemInfo()` (`items/context.ts`), backed by **`ItemInfoProvider`**
  (`items/ItemInfoProvider.tsx`) — a third app-level service mounted once in
  `App` alongside `SpriteProvider`/`EntityRegistryProvider`. It ingests the
  bridge's `itemInfo`/`enchantNames` envelopes (`onPacketBatch`, same pattern
  as `EntityRegistry`) into refs and re-renders consumers once per received
  table — unlike `EntityRegistry`'s per-change `subscribe`, these tables are
  asset-derived and essentially static for a session, so there's no granular
  change API, just "read the latest snapshot." It also reads `lootBagTypes`'s
  `shinyItemTypes` field (just that one field, not the rest of that envelope)
  into `isShiny` — see §4.3.
- **Enchantments** for an equipped slot: `ItemSprite` takes optional
  `ownerObjectId`/`slotIndex` props (threaded through by `GearRow` — see §3's
  `GearRow` entry), reads that entity's raw `enchantSlots` from
  `EntityRegistry`, and decodes the one slot it needs with
  `decodeEnchantIds` (`items/enchantDecode.ts`) — a TypeScript port of
  `bridge.dps.ParseEnchants#extractEnchantIds` (six-bit/base64url decode, no
  XML needed). Each decoded id is resolved to a name via
  `useItemInfo().enchantName`, falling back to `` `Enchant #${id}` `` when the
  bridge's `enchantNames` table has no definition for it (headless `--fake`
  mode, or any machine without `assets/xml/enchantments.xml`). A slot with no
  owner/index and no `enchantCode` simply shows no enchantment section —
  `rawSlot` stays `null`, distinct from a known-but-unenchanted slot (empty
  string, decodes to zero ids → "No enchantments").
- **`enchantCode`** (issue #122) is an optional prop that takes priority over
  the `ownerObjectId`/`slotIndex` live `EntityRegistry` lookup — a caller
  holding its own resolved (possibly frozen) enchant code passes it directly
  instead. `GearRow`'s own optional `enchantSlots` prop forwards per-slot
  codes this way; `DpsDetailPanel`'s `EnemyRow` passes its frozen
  `PlayerCosmetics.enchantSlots` (§5.1) so a past instance's gear tooltip
  still shows enchantments after `EntityRegistry` has moved on. The Loot panel
  (§7) has no equipping entity for most pickups (the protocol never
  broadcasts a bag-slot item's enchant data — only currently-equipped slots
  carry `UNIQUE_DATA_STRING`), but *does* pass `ownerObjectId`/`slotIndex`
  for an entry whose `objectType` matches one of the local player's
  currently-equipped slots — the one case where the enchant data is actually
  known.
- **`Tooltip`** (`ui/Tooltip.tsx`) is the presentation primitive — see
  `overlay-ui-style.md`'s primitives table for its props. Two things about it
  are specific to this overlay, not generic tooltip behavior:
  - **It escapes `PanelFrame`'s clipping.** `PanelFrame`'s outer frame is
    `overflow-hidden` and its content wrapper `overflow-auto` (§2), so an
    inline-rendered tooltip would be cropped. `Tooltip` instead
    `createPortal`s its bubble straight to `document.body`, then
    viewport-clamps its own position in a `useLayoutEffect` two-pass
    measure-then-position (mount off-screen-but-in-the-DOM to read its real
    rendered size, then reposition and reveal) — see the file's docstring for
    why a two-pass measure beats guessing a fixed max size.
  - **It must never break click-through mode.** `PanelFrame` already makes a
    non-interactive panel's entire DOM subtree `pointer-events-none` (§2), so
    a trigger *inside* a panel never receives a hover event to begin with —
    but `Tooltip`'s portal renders *outside* that subtree (into
    `document.body`), so it can't lean on inheriting that CSS. Instead
    `Tooltip` reads **`useInteractive()`** (`ui/interactiveContext.ts` — a new
    `InteractiveContext` provided once in `App`, mirroring the `interactive`
    boolean already threaded as an explicit prop through
    `AppShell`→`PanelCanvas`→`PanelFrame`) and, when not interactive, renders
    `children` completely unwrapped: no extra `div`, no `onMouseEnter`
    listener, no portal. The click-through contract is preserved by never
    attaching a hover target at all, not by hiding one — there is nothing for
    the browser to dispatch a hover event *to*.

### 4.3 Shiny item badge (`sprites/shiny.ts`, issue #193/#215)

A "shiny" item has no dedicated **wire signal for its name** — per the
game-data ground-truth rule (root `CLAUDE.md`), `assets/facts/asset-facts.json`
marks one purely by a trailing `" Shiny"` suffix on `items[id].name`
(`displayId` carries the base name instead, e.g. id `1210`:
`name: "Dirk of Cronus Shiny"`, `displayId: "Dirk of Cronus"`). An early
version derived shininess client-side by re-checking that suffix on the Loot
panel's resolved display name (`itemNames`, §7) — but that name comes from
`IdToAsset.objectName`, which **prefers `displayId` over the raw id whenever
one is set**, and on real assets nearly every shiny item has one (it shares
its base item's display name). A live alpha soak (#215) caught this: the
suffix was silently stripped before it ever reached the client, so the badge
never rendered on a real shiny drop despite working in dev (`--fake` mode's
synthetic item happened to keep the suffix in its display name too, masking
the bug — see below).

The fix adds a **dedicated boolean-ish wire signal**, independent of any
display name: `LootBagTypes.envelopeJson()` includes `shinyItemTypes` (a
`List<Integer>` of shiny item objectTypes, from `IdToAsset.isShiny` — checked
against the item's raw id, never `objectName`'s resolved value). `LootTracker`
stores it as a `Set<number>` and exposes `isShiny(objectType)` — now only a
class-level API exercised directly by `test/loot-replay.test.ts`, since
`useLootTracker()`'s own `isShiny` field was dropped as dead once `LootPanel`
(its sole consumer) moved to `ItemSprite`'s global lookup below.
`sprites/shiny.ts` now holds only the sprite-name constant, not any detection
logic.

**Rendering is centralized in `ItemSprite`, not per-caller (issue #250).**
Originally only `LootPanel` computed `isShiny(entry.objectType)` (from its own
`useLootTracker()` instance) and passed it as `ItemSprite`'s `shiny` prop —
`GearRow`, the shared equipped-item renderer every gear-showing panel
(Character/DPS list/DPS summary/DPS Detail/Instance) routes through, never
accepted or forwarded one, so the badge only ever appeared on Loot panel
entries, never on equipped gear anywhere else. Since shininess is a global
per-objectType fact (not tied to *how* an item is being displayed),
`ItemSprite` now resolves it itself from `useItemInfo().isShiny` — a second,
lightweight reader of the same `shinyItemTypes` field, added to
**`ItemInfoProvider`** (§4.2) precisely because it's already the app-level,
mounted-once home for small asset-derived per-objectType facts, so no caller
needs to instantiate a full `LootTracker` (with its per-session bag-tracking
machinery) just to answer "is this objectType shiny." `ItemSprite`'s `shiny`
prop is now optional and only needed to *override* that lookup; every current
call site (`GearRow`, `LootPanel`, the notification icons in
`NotificationsPanel`/`AlertToastHost`) omits it and gets the correct badge for
free, including any future item-rendering surface.

`Sprite` itself is unchanged: when the bridge's `uiSprites` pack section is
available (issue #205/#206), it resolves `shiny.ts`'s
`SHINY_ICON_SPRITE_NAME` (`shiny_item_icon`) via `useSprites().getUiSprite`
and renders that real sprite absolutely positioned over the sprite's
top-left corner — the same "overlay without changing layout size" technique
`rarity` uses (§4.1). Otherwise it falls back to a small SVG
rainbow-gradient star (`ShinyBadge` in `Sprite.tsx`) in the same position.
Either overlay needs an actual `position: relative` wrapper span since
neither can be a class on the sprite element itself (see §4's `Sprite`
writeup). The fallback gradient's `<svg id>` is generated via `useId()` so
multiple shiny badges on screen at once don't collide on a duplicate DOM id.

`FakePacketSource` seeds one real facts item whose **raw id** keeps its
`" Shiny"` suffix (`SHINY_ITEM_TYPE`, via `registerFactsItem`, which now always
registers the raw facts `name` as the id name and the `displayId`-preferring
name as the display name — matching the real client's split, so `--fake`
mode exercises the exact mechanism the real bridge does) and drops it in a
dedicated loot-bag cycle variant, so the badge is exercised in dev with no
game installed. It also equips it into one roster member's ring slot (issue
#250 — `ROSTER_EQUIPMENT[2][3]`, Carol), so the equipped-item path
(`GearRow`/`ItemSprite`, not just the Loot panel) is exercised too; the
mutation happens in `start()`, after `SHINY_ITEM_TYPE` resolves from the
bundled facts, since `ROSTER_EQUIPMENT`'s own static initializer runs too
early to reference it directly (a Java illegal-forward-reference issue, not a
runtime one). The committed `docs/screenshots/panels/` gallery and
`test/fixtures/gallery.json.gz` predate the `shinyItemTypes` wire field
(issue #215 postdates the gallery capture, PR #199) and so don't yet exercise
either the ground-loot or equipped-item badge — a pre-existing gap, not
something this issue's fix changes; regenerating that capture is a separate,
maintainer-side follow-up (see `docs/overlay-harness.md`'s "The `gallery.json`
fixture").

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
| `UpdatePacket` | `ingestUpdate` | `entityNames` (`NAME_STAT`), `enemyMaxHp` (`MAX_HP_STAT`), `objectTypes` (every seen objectId's `objectType`), `playerCosmetics` (skin/equipment/equipmentRarity/dyes, for history's frozen per-player sprite — §5.1, §4.1), and a despawn signal per dropped id |
| `objectNames` (synthetic) | `ingestObjectNames` | enemy names resolved bridge-side |
| `dps` (synthetic) | `ingestBridgeDps` + `recorder.onSnapshot` | **the Java engine's computed DPS snapshot**, also delta-diffed into the rate recorder (§5.2) |
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
   fight; but if the previous lock had already despawned (`bossAlive` false) —
   or we're in the open-world Realm (`inRealm`, where every quest-objective
   change is an independent boss, not a phase; see "Boss-phase damage carryover"
   below) — by the time the new objective arrives, `bossDamagedByLocal` resets
   instead, so focus does **not** snap to the new boss and stays on the
   just-killed one until the player lands a hit on the next — that's a genuinely
   new objective, not a phase continuation, treated the same as a fresh,
   undamaged encounter (`ingestQuestObjectId`).
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

**Boss-phase damage carryover — only across a *live* phase change, and never
in the Realm.** A boss changing form gets a brand-new `objectId` server-side
(a new `Entity` in the bridge's `DpsEngine`, damage total starting at zero —
see the discrepancy note in `dps-engine.md`), so carrying a boss's total
across phases is entirely the renderer's job. `ingestQuestObjectId` calls
`carryForwardBossDamage` on the *previous* `lockedBossId` before switching,
but **only when that previous lock is still alive** (`bossAlive` true) **and
we're not in the open-world Realm** (`!inRealm`) — a genuine phase/form change
on the same encounter. It snapshots the previous lock's current per-attacker
damage (`totalDamageRows` — bridge rows if present, else the **cumulative**
local totals; never the trimmed window buffers — see "Local rolling window"
below) into `bossCarry`, along with
that phase's recorder metrics (`engagedMs`/`peak` — §5.2), which sum/max
across phases. `snapshot()` then takes the `bossSnapshot` branch whenever
`bossCarry` is non-empty and the focus is still the locked boss: each row's
`damage` is `bossCarry + the current phase's live damage`, `dps` is just the
current phase's live rate (not a whole-encounter average), and `avgDps`/
`peakDps` are the whole-encounter combined metrics (total damage over summed
engaged span; max peak across phases).

If the previous lock had already **despawned** (`bossAlive` false) — **or the
instance is the Realm** (`inRealm`, from `MapInfoPacket` via `isRealmInstance`:
the Realm's `displayName` is the unresolved key `{s.rotmg}` and its realm-score
fields are `>= 0`, both `-1`/absent elsewhere) — a new objective is *not* a
phase change but an unrelated new encounter (the next quest boss). The Realm
cycles through many independent quest bosses with no instance change between
them, and carrying a dead boss's damage forward misattributes it to whichever
boss locks next — the bug behind "the DPS panel/summary rolls a killed Realm
boss's damage onto the *next* quest boss and snaps the label to it instantly."

> **Why the Realm needs its own gate (not just `bossAlive`).** When a Realm
> boss is killed, the game re-points the quest marker with a
> `QuestObjectIdPacket` for the next boss in the **same server tick** as, but
> **ordered before**, the `UpdatePacket.drops` that despawns the just-killed
> boss. So `bossAlive` is still `true` when `ingestQuestObjectId` runs — the
> despawn hasn't been processed yet — and the `bossAlive` check alone can't
> catch the swap (this is what defeated the earlier fix). A Realm boss-swap is
> otherwise packet-identical to a dungeon phase change (old id despawns, new id
> spawns as a fresh objectId at ~the same spot), so **instance context is the
> only signal that separates them.** Outside the Realm the `bossAlive` gate is
> unchanged, so dungeon multi-phase bosses still carry across phases. Regression:
> `dps-replay.test.ts`'s "Realm boss-swap rollover" cases, driven from the
> hand-authored `realm-boss-rollover.json.gz` fixture (which reproduces that
> exact same-tick ordering) — one case pins the Realm reset, the other the
> unchanged dungeon carry.

In the non-carry case `ingestQuestObjectId` calls `resolveBossChain()`, which
bakes the just-finished chain (its own `bossSnapshot`, merging any
still-unflushed `bossCarry` from that chain's own earlier phases) into its own
`resolvedBossEncounters` entry — see §5.1's "Boss-phase merging" — and clears
`bossCarry` so the new chain starts at zero rather than inheriting the old
one's total.

**Local rolling window — plus untrimmed cumulative totals.** `ingestDamage`
buckets hits as `targets[targetId][attackerId] = HitEvent[]`, redirecting a
minion's `objectId` to its owner via `minionOwners`. `snapshot` trims each
buffer **in place** to the last **`WINDOW_MS = 8000`** ms and computes
`dps = windowDamage / 8`. Because that trim mutates state, `ingestDamage` also
maintains a separate `cumulativeDamage` map (per-target, per-attacker running
sums, never trimmed), and everything that needs *whole-fight* totals
(`totalDamageRows`, and through it carry-forward/history) reads that instead
of summing the window buffers — the decoupling that makes one shared tracker
safe for both the live panel and history retention (see "One shared tracker"
in §5.1).

**Reset.** `reset()` wipes names, minion map, targets, `cumulativeDamage`,
focus, local id, the
boss lock (`lockedBossId`/`bossAlive`/`bossDamagedByLocal`/`bossCarry`), the
local attack streak (`localStreakTargetId`/`localStreakStartedAt`),
`enemyMaxHp`, `objectTypes`, `playerCosmetics`, `bossPhaseIds`, and the
recorder (`recorder.resetInstance()` — §5.2) — all
*per-instance* state. It runs on
`MapInfoPacket` internally (after `retainInstanceIfQualifying()` — §5.1) and is
also called from `DpsFeed.detach()` on overlay detach (which skips retention —
see §5.1). Debug
counters and the retained `history`/`historySeq`/`currentInstanceName` are
deliberately *kept* across resets — they're session-scoped, not per-instance.
Note `CreateSuccessPacket` does **not** reset — it only sets the local id.

### 5.1 Retained instance history (the DPS summary panel)

`DpsTracker` also retains a session-scoped, in-memory history of past
instances' damage, so a separate **DPS summary panel** (`DpsSummaryPanel.tsx`)
can show a post-fight master list, and its companion **DPS detail panel**
(`DpsDetailPanel.tsx`, opened on row click — §2's "Programmatic panel
spawn/close") a per-enemy/per-player breakdown, with no time pressure —
unlike the live DPS panel (§3), which only ever shows the currently-focused
enemy.

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
`playerCosmetics` map (objectId → skin/equipment/equipmentRarity/enchantSlots/
clothingDye/accessoryDye), merged from `UpdatePacket` the same way
`EntityRegistry` does but kept independent, and a history entry's
`DpsHistoryEnemy.cosmetics` is a **snapshot copy** taken at retention time
(each array field, including `enchantSlots`, sliced rather than aliased, so a
later live mutation of the still-tracked `playerCosmetics` record can't leak
into an already-retained history entry). `DpsDetailPanel.tsx`'s
`FrozenCharacterSprite` renders directly from that frozen record (`<Sprite
objectType clothingDye accessoryDye>`), never through
`CharacterSprite`/`useEntityRegistry`; `EnemyRow`'s `GearRow` similarly passes
the frozen `enchantSlots` (not `ownerObjectId` alone) so the gear tooltip's
enchant section (§4.2) still resolves after the live registry has moved on
(issue #122 — previously it silently went blank for any past instance).

**Shape.** `getHistory(): DpsHistoryEntry[]` returns the retained list, newest
first, capped at `HISTORY_MAX_INSTANCES` (oldest dropped). Each
`DpsHistoryEntry` is `{ id, instanceName, endedAt, localPlayerId, enemies:
DpsHistoryEnemy[] }`; each `DpsHistoryEnemy` is `{ id, name, objectType,
players: PlayerDps[], cosmetics: Map<objectId, PlayerCosmetics> }`, sorted
descending by total damage. Retained `PlayerDps` rows also carry the frozen
recorder metrics `avgDps`/`peakDps` (§5.2) when the recorder observed that
(enemy, player) — attached by `withMetrics()` for flat enemies and by
`bossSnapshot()`'s combined-metrics pass for chains; **absent, not 0**, when
it never saw a delta (e.g. the fight predated attach). `objectType` (the enemy's own, from `objectTypes`)
feeds the master-list icon fallback chain (§3): dungeon-icon map
(`useSprites().dungeonIcon(instanceName)`) → the top-ranked enemy's
`objectType` (the "main-boss sprite") → a generic placeholder chip.

**One shared tracker (PRD §3, `prd-dps-graph.md`).** There is exactly **one**
`DpsTracker` per app session, owned by `DpsFeed` (`dps/dpsFeed.ts`) and
mounted at App level by `DpsFeedProvider` — `useDpsTracker()` (live panel)
and `useDpsHistory()` (summary panel) are *views* over it, subscribing via
`feed.onBatch`/`feed.onDetach` rather than `window.overlay.onPacketBatch`
directly. Two things make this safe and correct:

- **Post-ingest notification.** React flushes effects bottom-up (children
  before parents), so a child hook subscribing to the preload bridge itself
  would run *before* the App-level provider's ingest and read one batch
  stale. `DpsFeed.ingest()` ingests first, then notifies its listeners.
- **The cumulative-totals decoupling** (§5's "Local rolling window"): the
  live view's periodic `snapshot()` trims window buffers in place, which
  before this refactor would have truncated the history/carry fallback
  totals — the hazard that used to force two separate tracker instances
  (`test/dps-shared-tracker.test.ts` pins this).

Because ingestion lives in the App-level provider — not in any panel — the
"session-scoped" retention contract no longer depends on the summary panel
being in the layout at all; `useDpsHistory` backfills `getHistory()` on
mount for whatever was retained before its panel first rendered.

### 5.2 The rate recorder — trend sparkline + avg/peak metrics

`DpsRateRecorder` (`dps/DpsRateRecorder.ts`) implements `prd-dps-graph.md`
§2: it **delta-diffs consecutive bridge `dps` snapshots** — the only feed
containing the local player's reconstructed self-damage — into `BIN_MS =
250 ms` time bins (one per bridge heartbeat). Owned by the shared
`DpsTracker` (fed from its `dps` ingest case with the envelope's own `time`;
reset with it), it maintains two things:

- **The aggregate graph series** — the local player's summed deltas across
  *all* enemies, retained for the trailing `GRAPH_WINDOW_MS = 10 s` (plus
  smoothing lead-in). `graphSeries(nowMs)` returns 40 points, each a
  trailing-`SMOOTH_MS = 2 s` average, plus `windowMax`/`current`.
- **Per-(enemy, player) fold state** — O(1) running metrics: observed
  `damage`, engaged span (`firstBin..lastBin`, so `avgDps = damage /
  engagedMs` floored at one bin — a one-tick burst kill shows its true large
  rate, not the bridge quotient's 0), and `peak` (max trailing-2 s average,
  never reported below `avgDps`). **No per-player time series is retained
  anywhere** — the scrapped other-player graphs stay scrapped.

Delta rules (all pinned in `test/dps-recorder.test.ts`): first sight of a key
only sets its baseline (a mid-fight attach must not spike a bin with the
whole pre-attach total — such rows simply never get metrics and render "—");
a negative delta (bridge restart) contributes nothing and re-baselines; a key
absent from a snapshot means *unchanged*, never "went to zero"; bins close on
**time**, not envelopes, so the series decays to zero when the stream goes
quiet.

**The sparkline** (`DpsSparkline.tsx`, the standalone `dpsGraph` panel's
entire body, own sm/md/lg presets — issue #259): bare inline SVG — a 2 px
`accent` curve + low-alpha area fill, no axes/gridlines/legend, one direct
label (the current smoothed value, in text tokens). Data arrives via
`useDpsGraph()` on a fixed `BIN_MS` interval (~4 Hz); while the series is
flat at zero the hook returns the previous state object so nothing
re-renders — steady-state GPU work over the game stays zero.

The line is a smoothed curve, not a hard-vertex polyline: `smoothLineD`/
`smoothAreaD` draw a quadratic Bezier to each segment's midpoint (control
point = the real data point), which stays within the convex hull of its own
inputs — a flat zero line can't dip negative and the curve can't rise past
its own peak, unlike a Catmull-Rom-style spline. New bins enter via the
PRD §4's sanctioned smooth-scroll upgrade path: one extra (previous-frame)
bin is rendered off the group's rest position, and a `<g>` wrapping the path
slides into place via a compositor-only CSS `transform`, restarted once per
bin tick (a one-shot `requestAnimationFrame` to force the browser to animate
the transition, not a perpetual rAF loop). Because the hook skips re-renders
while flat at zero, an idle overlay never re-triggers the slide — animation
cost stays at zero between ticks and while nothing changes, matching the
PRD's compositor-cost constraint. All of this stays contained in this one
component by the binding layering contract.

**The detail-panel metrics** (`DpsDetailPanel.tsx`): each expanded per-player
row shows `avg <avgDps> · peak <peakDps>` from the frozen history metrics —
**not** the wire `dps` field, whose `damage/fightMs` quotient reads 0 for
burst kills (bridge tick quantization) and carried phases (PRD §1's two
zero-producers). A metric-less row renders an em dash. The wire `dps` field
itself is unchanged and still present on every row.

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

The live panel's view over the shared feed (see "One shared tracker", §5.1 —
ingestion and detach-reset are `DpsFeedProvider`'s job, not this hook's): a
`feed.onBatch` subscription that re-snapshots whenever a batch contains a
`dps` envelope — the bridge pushes one within ~50 ms of any damage
packet (coalesced) plus a 250 ms heartbeat (see `bridge-server.md`) — or a
`QuestObjectIdPacket` envelope, so a boss lock/phase transition renders
immediately rather than waiting for the 1 s fallback tick below. This keeps the
panel effectively event-driven, not polled — `feed.onDetach` resets the local
snapshot to empty, and a slow **1000 ms** `FALLBACK_INTERVAL_MS`
`setInterval` recomputing `snapshot(Date.now())` exists only so the
client-side rolling-window fallback (used when the bridge has no data for the
focused enemy) still decays when packets go quiet.

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
at `sm` where the gear icons are hidden. The fill's *color*, not just its
width, also encodes `damage / topDamage` — `color-mix`'d between the
`--color-meter-high`/`--color-meter-low` tokens — so the top damager's row
reads clearly green and low-share rows read red even when two bars are
similar lengths (`overlay-ui-style.md`). The row's name uses full-opacity
`text-fg`, not the dimmer `text-fg-muted` other row text uses, since it sits
directly on the color-coded fill and needs the extra contrast across the
whole gradient. The row is clipped
(`overflow-hidden rounded-sm`) so the fill can never overflow the row or panel.
Every row, real or placeholder, gets an explicit fixed height (`rowHeight`,
via `MeterRow`'s `height` prop) so the list's total rendered height is
constant regardless of how many rows are real vs. blank. Row text size also
scales with panel size (`MeterRow`'s `textSize` prop, driven by
`DPS_ROW_TEXT_SIZE`) — `xs` at `sm`, `sm` at `md`/`lg` — independent of the
`2xs` badges/secondary figures, which stay fixed.

The local player's row (`row.objectId === entities.localPlayerId()`,
`MeterRow`'s `highlight` prop) gets an accent ring and a `#rank` badge ahead
of its name giving its true position in the full (unsliced) ranking — no
fill tint, so the fill color stays a pure function of damage share and the
local player is identifiable by ring + badge alone, independent of how
"hot"/"cool" their own bar happens to read. Two layers keep that row always present:
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

## 7. Loot panel — session-scoped bag-drop log

The Loot panel (issue #105) logs every item that *drops* in a white bag
(`BagType` 6) or orange/ST bag (`BagType` 8) near the local player — the two
colors players actually screenshot — grouped under each color's own bag
sprite. It reads the loot-**bag entities** that appear in the world, so an
item is logged when the bag drops, whether or not the player picks it up. (An
earlier version watched the local player's own inventory slots, and so only
ever saw pickups; it also needed to special-case equip/unequip self-swaps to
avoid false positives — that whole class of problem disappears when the source
is the bag itself.) Categorization is entirely asset-derived (no
hand-maintained item list): see [asset-pipeline.md](asset-pipeline.md)'s
"BagType — loot categorization" section for how `<BagType>` is extracted and
shipped as the bridge's synthetic `lootBagTypes` envelope, and
[bridge-server.md](bridge-server.md) §6 for the broadcast mechanics. The
underlying `LootTracker` class is more general than the panel: the envelope
itself carries every BagType present in the loaded assets (issue #217), and
`LootTracker`'s tracked-bag-type set is a constructor parameter — the Loot
panel just happens to construct one with the narrow `[6, 8]` default. The
notification system (`docs/prd-notifications.md` §2) is the other consumer,
constructing its own wide (all-color) instance.

### `LootTracker` (`loot/LootTracker.ts`)

A framework-agnostic class (no React, same shape as `DpsTracker`) ingesting
`PacketEnvelope[]` independently of every other tracker. It mirrors the
upstream `tomato` overlay's `DungeonStatData.updateItems`, which reads a loot
bag container's 8 item slots the same way.

**Tracked-bag-type set (issue #217).** The constructor takes an optional
`trackedBagTypes: readonly number[]`, defaulting to `TRACKED_BAG_TYPES`
(`[6, 8]`) — only entries whose BagType is in that set are kept from
`bagTypeTable`/`lootBagIcons`/`lootBagObjectTypes` when a `lootBagTypes`
envelope is ingested; everything else is silently dropped, same as before
this widening for the default two-color instance. `useLootTracker()` (the
Loot panel's hook) still constructs a default instance, so the panel's
tracked set and displayed behavior are unchanged. `LootEntry` gained a
`slotType` field (from the envelope's `slotTypes` map, `0` when
unresolved) — the notification system's per-category enchant-threshold rules
key off it.

**Detecting a bag.** The `lootBagTypes` envelope carries `lootBagObjectTypes` —
every loot-bag *entity* objectType for the tracked colors (regular *and*
boosted variants), each mapped to its `BagType`. An `UpdatePacket.newObjects`
entry whose `objectType` is in that set is a loot bag; the tracker records its
objectId in an in-view map. A loot bag's 8 slots are `INVENTORY_0..7` (wire
`statTypeNum` **8-15**) — the container's own slots, a different range from the
`INVENTORY_4..11` (12-19) *held* slots a player carries, so a player entity is
never mistaken for a bag.

**Startup race.** The bridge's `lootBagTypes` broadcast has a ~2s startup delay
(`bridge-server.md` §6), so a bag can spawn before `bagEntityTypes` is
populated — its `newObjects` entry would otherwise fail the lookup and be lost
for good, since a later `NewTickPacket` delta only resolves a bag already in
the in-view map. `LootTracker` queues any `newObjects` entry it can't yet
classify in `pendingNewObjects` and replays the queue once the first
`lootBagTypes` envelope arrives (a one-time catch-up; the queue is also
dropped on `resetPerInstance` since a map change invalidates those objectIds).
The queue is bounded (`MAX_PENDING_NEW_OBJECTS`, oldest evicted first) as a
memory bound rather than a correctness guarantee — every `newObjects` entry
queues pre-meta, not just bags, so unusually heavy non-bag traffic in that
window could in principle evict the earliest-queued (and thus race-triggering)
bag before meta arrives.

**Reading contents + enchants.** For each bag slot holding an item id, the item
is categorized by *its own* `BagType` (from `bagTypeTable`), so a lower-tier
filler item sharing a bag isn't listed. Each item's enchantments come straight
from the bag entity's own `UNIQUE_DATA_STRING` stat — a comma-separated
per-slot encoded enchant code, the *same* stat and wire shape `EntityRegistry`
reads for a player's equipped slots (§4.2), just on the bag for slots 0-7. The
raw per-slot code is stored on the `LootEntry` (`enchantCode`) and its rarity
tier (`slotRarityTier`, = filled enchant count) precomputed; `LootPanel` feeds
both to `ItemSprite` for the rarity border and the tooltip's enchant list.
(This corrects an earlier assumption that the wire never carries a dropped
item's enchants — it does, on the bag, which is exactly what the game client
renders enchant pips from when you hover a bag.)

**Dedup.** A bag re-entering view — or a `NewTickPacket` delta updating it (a
delta carries no objectType, so a bag is only recognized there once
`newObjects` has introduced its id) — re-sends the same contents; each
`(bagObjectId, slot)` is logged once. The log is chronological, not a
de-duplicated set, so two identical drops in one session both appear. A
`UpdatePacket.drops` id removes that bag's in-view bookkeeping (`bagsInView`,
so a later `NewTickPacket` delta for it is ignored until `newObjects`
re-introduces it) but deliberately **not** its logged-slot record
(`loggedBagSlots`) — that persists until `resetPerInstance()`/a map change.
A stationary ground bag sends its own id through `drops` whenever it merely
leaves the client's render range (the player walks away), not only when it's
destroyed/emptied; clearing `loggedBagSlots` there too (soak #237) meant
walking back into range re-logged — and re-notified for — the exact same
slots each time.

**`onEntry` subscription (issue #217).** `onEntry(listener)` registers a
callback invoked exactly once per newly-logged entry (returns an unsubscribe
function). It fires from the same push inside `processBagSlots` that both the
live `newObjects`/`NewTickPacket` path and the `pendingNewObjects` startup-race
replay above go through, so a listener sees every entry exactly once
regardless of which path logged it — no separate wiring needed for the replay
case. This is what lets a caller (the notification system's alert engine,
issue #218) see each drop as a discrete event instead of diffing `entries`
itself; the Loot panel doesn't use it (`useLootTracker` still re-renders off
`ingest()`'s return value).

**Session-scoped, mirroring `DpsTracker`'s retained history (§5.1).** `entries`
(the log itself) persists across `MapInfoPacket` and is cleared only by
`reset()` (overlay detach / game close). `MapInfoPacket` calls
`resetPerInstance()` (forgets the in-view bags + their logged slots — bags are
per-instance), never touching `entries`. `bagTypeTable`/`lootBagIcons`/
`bagEntityTypes`/`itemNames`/`shinyItemTypes`/`slotTypes` (asset-derived
categorization) are never cleared by either reset — like the sprite pack,
they're app-lifetime data.

### `useLootTracker` (`loot/useLootTracker.ts`)

One dedicated `LootTracker` instance per hook call (same pattern as
`useDpsHistory`), piping `onPacketBatch` into `tracker.ingest`. `ingest()`
returns whether anything display-relevant changed (a new entry, or the
`lootBagTypes` meta updated), so the hook only re-renders on an actual change.

### `LootPanel` (`panels/LootPanel.tsx`)

Both tracked BagTypes (6, 8) always render, even at a 0 count (issue #193) —
no per-category hiding and no whole-panel `EmptyState`, so the panel's layout
is stable across a session instead of jumping around as categories fill in.
Each category's header is just its bag-color sprite (`bagIcon(bagType)`, the
ordinary `<Sprite objectType>` path) plus the count — no "White Bag"/"Orange
Bag" text, the sprite is recognizable on its own. Every dropped item renders
through **`ItemSprite`** (§4.2) — the rarity border from `entry.rarity`, the
shiny badge (`ItemSprite`'s own `useItemInfo().isShiny` lookup, issue #250 —
§4.3), and the
hover tooltip (item name/tier/class/description from `itemInfo`, plus the
enchant list decoded from `entry.enchantCode` via `ItemSprite`'s
`enchantCode` prop, the same path `DpsDetailPanel` uses for frozen history)
— **newest first** so the latest drop is visible without scrolling. The
resolved item name (`itemName`, from `lootBagTypes`'s `itemNames` table)
renders beside the sprite at `size === 'lg'`. The scroll container carries a
`p-1.5` inset so an edge item's rarity indicator (bottom-right pip/ring) and
shiny indicator (top-left icon/badge) — both outset overlays that extend past
the sprite's own box — aren't clipped by the container edge (issue #193; with
no inset, `overflow-y-auto` clips exactly at the content edge). Sized/registered via the standard checklist
(§2): `registry.ts`'s `loot` entry, a default-layout instance in
`PanelCanvas.tsx`.

---

## 8. Notification system (issues #218-#221)

`useAlertEngine()` mounts one `AlertEngine` instance in `App.tsx` (called
unconditionally near the top of the component, alongside the other
App-level effects) — unlike every per-panel tracker (`useLootTracker`,
`useDpsHistory`), this one is a **singleton at App level**, because its side
effects (a banner, a ping sound) must fire even when no panel is open. Its
`ingest`/`reset` are wired to the same `onPacketBatch`/`onOverlayDetach`
events every tracker uses, plus `getSettings`/`onSettingsChanged` so a live
settings change applies without an engine restart; the hook returns both the
engine and the live `notifications.volume` (issue #219), which `App.tsx`
forwards to `AlertToastHost`.

`AlertEngine` owns a **second, private** `LootTracker` instance — not the one
`useLootTracker()` creates for the Loot panel — constructed with a wide
static superset of BagType ids so it sees a drop in any bag color, not just
white/orange (§7's "the notification system is the other consumer" note).
Each new entry (`onEntry`, issue #217) becomes a `loot-drop` `GameEvent`,
matched against a small rule catalog (`whiteBag`/`orangeBag`/
`enchantedDrop`), and any match is appended to a bounded, subscribable
`FiredAlertStore` — the store's subscribe API is the contract every UI
surface reads from, so the history panel (issue #220) and the settings gear
(issue #221) never need to reach into `AlertEngine` internals.

`AlertToastHost` (issue #219, rendered in `AppShell` above `PanelCanvas` —
§2's panel system doesn't apply to it, it's not a `PANEL_REGISTRY` entry)
consumes that store directly: a new alert with its `banner` flag set becomes
a capped/auto-dismissing toast (`toastQueue.ts`'s `ToastQueue`), one with
`sound` set plays the bundled ping (`sound.ts`'s `pingPlayer`, coalesced to
≤1 per ~700ms). `main/index.ts` sets Chromium's `autoplay-policy` switch so
the ping plays with no prior user gesture — a fired alert is a game event,
not a click.

`NotificationsPanel` (issue #220) is the store's **second** UI surface, and
unlike `AlertToastHost` it *is* an ordinary §2 `PANEL_REGISTRY` entry
(`registry.ts`'s `notifications` key, in `PanelCanvas.tsx`'s
`defaultLayout()`). It reads the same `alertEngine.store` instance via
`alertStoreContext.ts`'s `AlertStoreContext` — a context rather than a prop,
since the panel is mounted by registry lookup with no direct parent/child
relationship to `App.tsx` (`App.tsx` provides the context around `AppShell`
alongside the existing `alertStore` prop it already passes to
`AlertToastHost`). A pure viewer, newest-first, showing each fired alert's
time/icon/title/body/`matchedKindIds` — deleting it from the layout doesn't
stop alerts firing, same "pure viewer" property `LootPanel` has over
`LootTracker`.

`NotificationsPanel`'s settings gear (issue #221, `AlertSettings.tsx`) is the
first user of the generic per-panel gear mechanism described in §2's
"Per-panel settings gear" above — a `PanelSpec.settings` component
`PanelFrame` flips the panel body to in place, no floating popover. It reads
and writes `OverlaySettings.notifications` directly (`getSettings`/
`saveSettings`, debounced, apply-on-change), rendering one row per `CATALOG`
entry via the React-free `settingsRows.ts`'s `buildRuleRows()` and, for
`enchantedDrop`, its registered params editor
(`alerts/paramsEditors.ts`/`EnchantedDropParamsEditor.tsx`) — a category/
item-name override editor backed by `slotTypeNames.ts` and
`useItemNameCatalog.ts`'s live `lootBagTypes.itemNames` subscription.

Full architecture, the multi-match dispatch semantics, the delivery layer,
the history panel, the settings gear/schema, and the SlotType name
derivation: see **[notifications.md](notifications.md)**.

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
