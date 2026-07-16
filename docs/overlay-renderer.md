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
| `overlay/src/renderer/src/panels/PanelCanvas.tsx` | Owns the panel array, layout load/save, drag/size/pin/z-order dispatch, programmatic open/close. |
| `overlay/src/renderer/src/panels/PanelFrame.tsx` | One panel's chrome: title bar, drag, size/pin/close buttons, visibility. |
| `overlay/src/renderer/src/panels/panelSpawn.ts` | `PanelSpawnContext` / `usePanelSpawn()` - lets a panel body open/close another panel on the canvas (§2's "Programmatic panel spawn/close"). |
| `overlay/src/renderer/src/panels/anchor.ts` | Percentage-anchor ↔ pixel math (`panelStyle`, `anchorFromPointer`). |
| `overlay/src/renderer/src/panels/registry.ts` | `type → { title, per-size px dims, component, closable? }` and `PanelContentProps`. |
| `overlay/src/renderer/src/panels/{Status,Dps,Console,Character,Instance,DpsSummary,DpsDetail,Loot}Panel.tsx` | The eight panel bodies. |
| `overlay/src/renderer/src/ui/*.tsx` | Shared UI primitives (`Button`, `EmptyState`, `Swatch`, `GearRow`, `MeterRow`, `StatRow`, `Tooltip`) — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/ui/interactiveContext.ts` | `InteractiveContext` / `useInteractive()` - the click-through-mode flag, for `Tooltip` (§4.2). |
| `overlay/src/renderer/src/assets/main.css` | Tailwind entry + the `@theme` design-token block — see `overlay-ui-style.md`. |
| `overlay/src/renderer/src/sprites/SpriteProvider.tsx` | Loads/decodes the atlas pack; `getSprite` / `getDyedSprite`. |
| `overlay/src/renderer/src/sprites/outline.ts` | `outlineImageData`/`dilateSilhouette` — bakes RotMG's thin black silhouette outline into a cropped/composited sprite. |
| `overlay/src/renderer/src/sprites/Sprite.tsx` / `CharacterSprite.tsx` | `<Sprite objectType>` / `<CharacterSprite objectId>` components. |
| `overlay/src/renderer/src/sprites/EntityRegistry.tsx` | objectId → name/skin/equipment/equipmentRarity/enchantSlots/dyes, built from the packet stream. |
| `overlay/src/renderer/src/sprites/context.ts` | The two React contexts + `useSprites` / `useEntityRegistry` hooks. |
| `overlay/src/renderer/src/sprites/enchantRarity.ts` | Decodes `UNIQUE_DATA_STRING` into a per-slot rarity-border tier (issue #107) — see §4.1. |
| `overlay/src/renderer/src/sprites/ItemSprite.tsx` | `<ItemSprite objectType>` - the shared item-rendering path (§4.2): wraps `Sprite` with the hover item/enchant tooltip. |
| `overlay/src/renderer/src/items/ItemInfoProvider.tsx` | Ingests the `itemInfo`/`enchantNames` envelopes; provides item metadata + enchant-name lookups (§4.2). |
| `overlay/src/renderer/src/items/context.ts` | `ItemInfoContext` + `useItemInfo()` hook. |
| `overlay/src/renderer/src/items/enchantDecode.ts` | Client-side six-bit/base64url decode of an equipped slot's raw `UNIQUE_DATA_STRING` into enchant ids. |
| `overlay/src/renderer/src/items/types.ts` | Wire shapes of the `itemInfo`/`enchantNames` envelopes. |
| `overlay/src/renderer/src/dps/DpsTracker.ts` | Framework-agnostic class ingesting packets → `DpsSnapshot`; also retains a session-scoped per-instance damage history (§5.1). |
| `overlay/src/renderer/src/dps/useDpsTracker.ts` | React hook wrapping `DpsTracker` (event-driven on bridge `dps` packets + 1 s fallback recompute). |
| `overlay/src/renderer/src/dps/useDpsHistory.ts` | React hook owning a dedicated `DpsTracker` instance for the DPS summary panel; exposes `DpsHistoryEntry[]`. |
| `overlay/src/renderer/src/dps/dpsDetailContext.ts` | `DpsDetailSelectionContext` / `useDpsDetailSelection()` - the selected `DpsHistoryEntry` the `dpsDetail` panel renders (§2's "Programmatic panel spawn/close"). |
| `overlay/src/renderer/src/dps/DpsDetailSelectionProvider.tsx` | Owns the selection state for the context above; mounted once in `App`. |
| `overlay/src/renderer/src/dps/types.ts` | Packet-field shapes the tracker reads. |
| `overlay/src/renderer/src/loot/LootTracker.ts` | Framework-agnostic class ingesting packets → a session-scoped log of white/orange bags that dropped near the player, incl. per-item enchants (§7). |
| `overlay/src/renderer/src/loot/useLootTracker.ts` | React hook wrapping `LootTracker` (event-driven on `onPacketBatch`, re-renders only when `ingest` reports a change). |
| `overlay/src/renderer/src/loot/types.ts` | Packet-field shapes the loot tracker reads, incl. the synthetic `lootBagTypes` envelope. |
| `overlay/src/renderer/src/harness/*` | The browser renderer harness (no Electron) - dev-flag-gated, out of the production bundle. See `docs/overlay-harness.md`. |

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
explicit pixel width/height per preset (`registry.ts:21-72`), e.g. Character is
a literal `160×100 / 220×130 / 280×170`. The DPS panel's height is instead
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

Dragging is manual (no library). `PanelFrame.startDrag` (`PanelFrame.tsx:35`)
records the grab offset within the panel (so the panel doesn't snap its corner
to the cursor), then attaches window `mousemove`/`mouseup` listeners. Each move
calls `anchorFromPointer` (`anchor.ts:35-43`) to convert `(clientX - grabOffset)`
into a **clamped 0-100 % anchor** and writes the resulting position **directly
to the frame's DOM** — *not* through React state. Routing every pointer event
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
every frame, which forces a full layout + repaint). `width`/`height` are still
recomputed from `panelStyle` each move (for the near-an-edge clamp described
above) but only written to the DOM when the clamped value actually changes,
which is only near a canvas edge — the common frame does a transform-only
write. On top of that, `document.documentElement` gets the `panel-dragging`
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

### Programmatic panel spawn/close (issue #194)

Every panel in `defaultLayout()` is always present; nothing before issue #194
let one panel body open *another* panel on demand. The DPS summary/detail
split needed exactly that — clicking a session in the small `DpsSummaryPanel`
opens its per-enemy/per-player breakdown in a separate, much larger,
independently draggable/resizable `dpsDetail` panel instead of swapping the
summary panel's own cramped content in place — so this is now a small generic
mechanism any future panel can reuse, not a DPS-specific hack:

- **`panels/panelSpawn.ts`** — `PanelSpawnContext` / `usePanelSpawn()`, giving
  a panel body two calls: `openPanel(id, type, size?)` (creates a
  `PanelInstance` at a fixed default anchor if `id` isn't already in the
  canvas's `panels` array, otherwise just raises the existing one to front —
  so re-targeting an already-open panel, e.g. selecting a different session,
  never spawns a duplicate) and `closePanel(id)` (removes it from the array
  entirely). Both are implemented by `PanelCanvas` (`openPanel`/`closePanel`
  next to `updatePanel`/`bringToTop`) and provided via
  `<PanelSpawnContext.Provider>` wrapping its rendered panels — `PanelCanvas`
  itself has no DPS-specific knowledge; it only manipulates `PanelInstance[]`
  generically.
- **`registry.ts`'s `closable?: boolean`** on a `PanelSpec` — when set,
  `PanelFrame` renders a ✕ button in that panel's title bar (alongside
  pin/size) wired to `usePanelSpawn().closePanel(panel.id)` via the `onClose`
  prop `PanelCanvas` passes every `PanelFrame`. Only `dpsDetail` sets this
  today; an ordinary always-on panel (the other seven) leaves it unset and
  gets no close control.
- **A spawned panel is not in `defaultLayout()`** and is never added by
  `mergeWithDefaults` — it only exists in the `panels` array while open, so
  closing it and reopening later always respawns at `panelSpawn.ts`'s
  `SPAWN_ANCHOR` default position rather than resuming wherever it was last
  dragged. This was a deliberate simplicity tradeoff (position isn't preserved
  across a close/reopen cycle), not a limitation of the mechanism itself.
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
  indirection for a single consumer.
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

---

## 3. The panels

All eight bodies are thin; the data lives in the shared services. `size` maps
to per-panel scale tables at the top of each file. Every gear/loot icon below
renders through `ItemSprite`, not `Sprite` directly, so it's hoverable for the
item tooltip (§4.2) with no per-panel wiring.

| Panel | Title | Data source | Notes |
| --- | --- | --- | --- |
| `StatusPanel` | "RealmShark" | `window.overlay.*` directly | Connection dot, hotkey hint, packet count, JS heap MB, app version + **auto-update** UI. |
| `DpsPanel` | "DPS" | `useDpsTracker()` → `<DpsList>` | Rows per attacker vs. the focused enemy, ranked by cumulative damage (§5). `MAX_ROWS = {sm:2, md:3, lg:6}` — deliberately few, large rows (24-40px sprites) so the panel reads at a glance mid-fight, rather than the previous 3/6/12 dense layout. Each row also renders that attacker's dyed `CharacterSprite` + equip-slot icons (gear hidden at `sm`), resolved from `EntityRegistry` by `row.objectId`, plus a damage-share bar (length **and** color both encode `damage/topDamage`) and a rank badge/ring on the local player's row (§6). |
| `ConsolePanel` | "Console" | `consoleLog.ts` buffer | Live log with search (Ctrl/Cmd+F), level colours, clear. |
| `CharacterPanel` | "Character" | `EntityRegistry` (local player) | Big dyed sprite + 4 equip icons + username. |
| `InstancePanel` | "Instance" | `EntityRegistry.characters()` | Every named player in the instance, dyed sprites + gear. |
| `DpsSummaryPanel` | "DPS Summary" | `useDpsHistory()` | A master list only: retained past instances (icon + name + a "You: Xdmg (#rank)" headline). Clicking a row opens that instance's breakdown in the separate `dpsDetail` panel below rather than swapping this panel's own content — see §2's "Programmatic panel spawn/close" and §5.1. |
| `DpsDetailPanel` | "DPS Detail" | `useDpsDetailSelection()` | The large, closable, independently draggable/resizable panel `DpsSummaryPanel` opens on row click (issue #194): the selected instance's enemies ranked by total damage, expandable to a frozen per-player breakdown (gear/dyes/enchants). A single reused panel instance re-targeted on each new selection, not one spawned per session. Renders "No session selected" if opened with nothing selected (shouldn't happen via the normal row-click path). See §2, §5.1. |
| `LootPanel` | "Loot" | `useLootTracker()` | Session log of white/orange bags (BagType 6/8) that dropped near the player, grouped under each color's own bag sprite, with per-item rarity border + enchant tooltip, chronological (not de-duplicated). See §7. |

**StatusPanel** (`panels/StatusPanel.tsx`) is the only panel wired straight to
the IPC surface rather than a shared service. It subscribes to `onBridgeStatus`,
`onPacketBatch` (just to count: `packetCount += packets.length`, `StatusPanel.tsx:42-45`),
`onUpdateAvailable`, and `onUpdateProgress`, and polls `performance.memory`
(a non-standard Chrome/Electron field, guarded, `StatusPanel.tsx:14-22`) every
1 s. It also hosts the updater UI (Check / Update & restart), plus "Report bug"
and "Capture now" (`build-and-release.md`). Content beyond the header is gated
on `size !== 'sm'`, and the last-packet line only on `size === 'lg'` — `sm`
(160×50) stays a bare status glance with no actions at all, by design (#179).
At `md`/`lg` the three actions render as a single row of compact (`size="xs"`)
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
`rarity`, `className`). It picks `getDyedSprite` when a dye is present else
`getSprite` (`Sprite.tsx:51-53`), and renders an
`<img style={{imageRendering:'pixelated'}}>`. When the lookup returns `null`
(no real pack / undecoded atlas) it renders a **deterministic HSL placeholder
chip** so an unresolved objectType is still a stable coloured box
(`Sprite.tsx:16-19,67-79`). It also ticks its own animation clock:
`isAnimated(objectType, clothingDye, accessoryDye)` (from `SpriteContext`) says
whether this particular sprite has an idle-frame or textile-frame animation,
and only then does a local `setInterval` at `frameMs` re-render it
(`Sprite.tsx:37-45`) — static sprites and event-driven panels never tick.
`rarity` (0-4, see §4.1) adds a `ring-2 ring-rarity-<tier>` class on whichever
of the three render paths (canvas/`<img>`/placeholder) is taken, so it never
changes the sprite's rendered layout size the way a `border` would.

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
  change API, just "read the latest snapshot."
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
[bridge-server.md](bridge-server.md) §6 for the broadcast mechanics.

### `LootTracker` (`loot/LootTracker.ts`)

A framework-agnostic class (no React, same shape as `DpsTracker`) ingesting
`PacketEnvelope[]` independently of every other tracker. It mirrors the
upstream `tomato` overlay's `DungeonStatData.updateItems`, which reads a loot
bag container's 8 item slots the same way.

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
`UpdatePacket.drops` id removes that bag's in-view bookkeeping.

**Session-scoped, mirroring `DpsTracker`'s retained history (§5.1).** `entries`
(the log itself) persists across `MapInfoPacket` and is cleared only by
`reset()` (overlay detach / game close). `MapInfoPacket` calls
`resetPerInstance()` (forgets the in-view bags + their logged slots — bags are
per-instance), never touching `entries`. `bagTypeTable`/`lootBagIcons`/
`bagEntityTypes`/`itemNames` (asset-derived categorization) are never cleared
by either reset — like the sprite pack, they're app-lifetime data.

### `useLootTracker` (`loot/useLootTracker.ts`)

One dedicated `LootTracker` instance per hook call (same pattern as
`useDpsHistory`), piping `onPacketBatch` into `tracker.ingest`. `ingest()`
returns whether anything display-relevant changed (a new entry, or the
`lootBagTypes` meta updated), so the hook only re-renders on an actual change.

### `LootPanel` (`panels/LootPanel.tsx`)

For each tracked BagType (6, 8), an empty category is hidden; if both are empty
the panel shows the shared `EmptyState`. A non-empty category renders its
bag-color sprite (`bagIcon(bagType)`, the ordinary `<Sprite objectType>` path)
plus a count, then every dropped item through **`ItemSprite`** (§4.2) — the
rarity border from `entry.rarity` and the hover tooltip (item name/tier/class/
description from `itemInfo`, plus the enchant list decoded from
`entry.enchantCode` via `ItemSprite`'s `enchantCode` prop, the same path
`DpsDetailPanel` uses for frozen history) — **newest first** so the latest
drop is visible without scrolling. The resolved item name (`itemName`, from
`lootBagTypes`'s `itemNames` table) renders beside the sprite at
`size === 'lg'`. Sized/registered via the standard checklist (§2):
`registry.ts`'s `loot` entry, a default-layout instance in `PanelCanvas.tsx`.

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
