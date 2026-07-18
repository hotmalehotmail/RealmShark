# PRD: Overlay notification system ("Alerts")

**Status:** design accepted, not yet implemented
**Scope:** overlay renderer + two small bridge-side data additions (all-color loot
metadata, item slot types) + `FakePacketSource` extensions
**Implementation plan:** §11 — six dependency-ordered issues for the agent dev-loop

Notify the user when notable game events occur, via an in-overlay banner and/or a ping
sound. Built so that adding a new notification type is a one-file change, with per-event
user configuration (on/off, banner, sound, and small typed parameters where an event
needs one).

Decisions locked in with the maintainer:

- **Rule model:** fixed catalog of built-in event types + typed params (not a
  user-defined rule builder; one instance per event type).
- **Config UI:** per-panel settings — a gear icon on panels that declare settings,
  opening that panel's settings view in place. This PRD introduces the generic
  mechanism; the Notifications panel is its first user. Panels without settings show
  no gear.
- **Sound:** one bundled ping + a global volume slider in v1 (schema leaves room for
  per-rule sounds later).
- **History:** yes — a Notifications panel lists the session's fired alerts.
- **`enchantedDrop` scope:** covers drops in **all** bag colors (not just
  white/orange); default = banner + ping on **divine** (4-enchant) drops; users can
  lower the threshold per item category (wand, spell, …) or per specific item
  ("Doom Bow"). Most specific wins.

---

## 1. Shape of the system

One pipeline, three stages, nearly all in the renderer (`TextPacket` already crosses
the bridge; loot metadata needs the two small bridge additions in §2):

```
packet batch ──► Detectors ──► GameEvents ──► Rule evaluation ──► Dispatcher
                (reuse existing              (catalog × user      ├─► Banner toast host
                 tracker logic)               prefs)              ├─► Sound player
                                                                  └─► History log ──► Notifications panel
```

The load-bearing separation: **detectors** turn raw packets into a small vocabulary of
typed *game events*, and **catalog entries** are pure functions that match events
against user parameters. "Adding a new notification" almost never means touching
packets — it means adding one catalog entry against an existing event type. Only a
genuinely new *kind* of event (first death alert, first trade alert, …) requires a new
detector.

**Naming:** the subsystem is `alerts` internally (`AlertEngine`, `renderer/src/alerts/`)
with the user-facing label "Notifications". The packet stream already contains the
game's own `NotificationPacket`/`GlobalNotificationPacket`, and Electron has a global
`Notification`; `NotificationX` class names would collide confusingly in the same files.

**Layering contract (decoupling — binding for every implementation PR):** the engine,
catalog, and fired-alert store are plain TypeScript with no React/DOM imports,
testable headless; every UI surface — toast host, history panel, settings view —
consumes only the store's subscribe API (`FiredAlert` records) and the settings
schema. The banner UI is expected to be redesigned later: that redesign must touch
`AlertToastHost` alone. Symmetrically, a new notification type is one catalog entry
(+ a params-editor registration if it has params) and — only for a genuinely new
event kind — one detector; never a dispatcher, store, or UI-host change.

## 2. Stage 1 — detectors and events

`renderer/src/alerts/AlertEngine.ts` — a framework-agnostic class in the exact mold of
`DpsTracker`/`LootTracker`: an `ingest(packets: PacketEnvelope[])` method, a declared
`CONSUMED_ENVELOPE_TYPES`, `reset()` on detach.

It is mounted **once at App level** (not inside a panel), because banners and sounds
must fire even when no panel is open. This deliberately differs from the
per-panel-tracker pattern (`useLootTracker` creates a private instance per panel) —
those are pure views; this one has side effects (sound), so it must be a singleton. A
`useAlertEngine` hook in `App.tsx` owns it and exposes state via context to the toast
host and the panel.

v1 event vocabulary:

```ts
type GameEvent =
  | { type: 'loot-drop'; itemType: number; itemName: string | null;
      bagType: number; slotType: number; enchantCount: number; enchantCode: string }
  | { type: 'chat'; sender: string; text: string; numStars: number;
      channel: 'party' | 'guild' | 'pm' | 'local' | 'unknown' }
```

**Loot detector.** The engine owns its own internal `LootTracker` instance — detection
logic stays in one class, and multiple instances of the same tracker fed from the same
stream is already the established pattern here. `LootTracker` needs one small
extension: an `onEntry` callback (or `ingest` returning newly-added entries) so the
engine sees each new drop as an event instead of diffing `entries`. `enchantCount`
falls out for free — `LootEntry.rarity` *is* the filled-enchant count
(`slotRarityTier`), so "drop with 4 enchantments" is a predicate over the same
`loot-drop` event as the bag-color rules, not a separate detector.

**Bag-color coverage + slot types (the two bridge additions).** Two facts pinned from
the code and the committed asset facts
(`src/main/resources/assets/facts/asset-facts.json`): `bridge/LootBagTypes.java`
filters its envelope to bag types 6/8 **at the source** (`bt != 6 && bt != 8` → skip),
and item-level `SlotType` — which the game XML carries and the facts file already
records per item — is never parsed by the runtime `IdToAsset` (it only reads
projectile slots). So all-color `enchantedDrop` needs:

- `LootBagTypes.java`: emit `bagTypeTable`/`itemNames`/`lootBagObjectTypes` for **all**
  bag colors, plus a per-item `slotTypes` map (with `IdToAsset` extended to parse each
  item's own `SlotType`). `lootBagIcons` stays 6/8 — a Loot-panel-only concern.
  Size note: all-color coverage grows the item table from ~1.8k to ~11.4k entries
  (counted from the facts file; bagType 2 alone is 5,341 items). A one-time
  loopback broadcast, so likely fine, but measure it — if it bloats, `itemNames` can
  dedupe against the existing `itemInfo` envelope's `names`.
- `LootTracker`: the tracked-bag-type set becomes a constructor parameter — the Loot
  panel keeps `[6, 8]`, the engine's instance tracks every color. (The Loot panel's
  display is unchanged by any of this.)
- Behavioral consequence, accepted: non-soulbound bag colors are public, so nearby
  *other players'* drops can also fire the rule — arguably desired (a divine item on
  the floor is worth a ping regardless of whose kill it was).

**Chat detector.** Consumes `TextPacket` (`name`, `recipient`, `text`, `numStars` are
all on the wire — see `packets/incoming/TextPacket.java`). Subject to the hard
constraint in §6.

## 3. Stage 2 — the rule catalog

`renderer/src/alerts/catalog.ts` — the single file a contributor touches to add a
notification:

```ts
interface AlertKind<E extends GameEvent, P> {
  id: string                    // stable settings key: 'whiteBag', 'partyChat', ...
  title: string                 // shown in settings UI and history
  eventType: E['type']
  defaults: { enabled: boolean; banner: boolean; sound: boolean; params: P }
  /** Pure. Returns the banner payload if this event should fire, else null. */
  match(event: E, params: P): AlertPayload | null
}

interface AlertPayload {
  title: string                 // "White bag!"
  body: string                  // "Bow of Covert Havens (4 enchants)"
  icon?: number                 // objectType → rendered with the existing <ItemSprite>
}
```

The catalog imports no React (layering contract, §1): per-kind settings form
controls (threshold pickers, keyword lists) live in a UI-side registry —
`alerts/paramsEditors.tsx`, a `Record<kindId, ComponentType<…>>` — so the
engine/catalog stay headless-testable and presentation-free.

v1 catalog:

| id | event | params | default |
|---|---|---|---|
| `whiteBag` | loot-drop, bagType 6 | — | on, banner+sound |
| `orangeBag` | loot-drop, bagType 8 | — | on, banner+sound |
| `enchantedDrop` | loot-drop, **all** bag colors | tiered thresholds (see below) | on, banner+sound at divine |
| `partyChat` | chat, channel=party | `keywords: string[]` (empty = all) | off |

### `enchantedDrop` threshold resolution

```ts
params: {
  tier: 1 | 2 | 3 | 4                          // global threshold; default 4 (divine)
  slotTypeOverrides: Record<number, 1|2|3|4>   // SlotType id → lowered threshold
  itemOverrides: Record<string, 1|2|3|4>       // item name (lowercased) → threshold
}
```

Tier numbers are the repo's existing rarity mapping (`enchantRarity.ts`): filled
enchant count 1 = uncommon, 2 = rare, 3 = legendary, 4 = divine; the UI shows the
names, not numbers. Effective threshold for a drop =
`itemOverrides[name] ?? slotTypeOverrides[slotType] ?? tier`; the rule fires when
`enchantCount >= effective` — most specific wins.

Item overrides match the item's name case-insensitively and exactly. Shiny/reskin
variants are separate names ("Doom Bow" ≠ "Doom Bow Shiny"); the settings
autocomplete (backed by the widened `itemNames` table) surfaces both so users add
what they mean. Names rather than objectType ids: readable in `settings.json`, and
the autocomplete removes the typo risk.

Its params editor (registered in the UI-side `paramsEditors` map) is the richest one:
a tier dropdown, plus add-a-row overrides (category picker from the SlotType name
table, or item-name autocomplete, each with its own tier dropdown).

**SlotType names:** no id → name table exists anywhere in the repo or the dump-derived
facts today. Clustering the committed facts file's item names per slotType id pins the
ids empirically (slotType 8's items are the "Wand of …" family, 11 = spells/scrolls,
3 = bows, 17 = staves, … — verified against `asset-facts.json`, 2026-07-16
extraction). Commit the reviewed id → display-name table as a renderer constant with
that provenance; if the real dump turns out to carry an official slot-type name table,
extend `extractFacts` to emit it instead (open item, §10).

### Multi-match semantics

When one event matches several rules (a white bag *with* 4 enchants matches
`whiteBag` + `enchantedDrop`), the dispatcher resolves per channel:

1. Evaluate every *enabled* catalog rule for the event's type; collect matches. Drop
   any match whose kind is on cooldown. No matches left → nothing fires.
2. **Banner:** shown iff any surviving match has `banner: true`; the payload comes
   from the **first such match in catalog order**. Catalog order is the explicit,
   documented priority order (a comment in `catalog.ts`) — note it's the first match
   *that wants a banner*, not the first match overall.
3. **Sound:** one ping iff any surviving match has `sound: true` (still subject to
   the global ~700 ms coalescing). Never one ping per rule.
4. **History:** exactly one entry, carrying the displayed payload plus the full list
   of matched kind ids, so the panel shows why it fired even though one banner showed.

Worked example: white bag with a 4-enchant item, `whiteBag` set to banner-only,
`enchantedDrop` set to sound-only → one banner using `whiteBag`'s payload, one ping
(requested by `enchantedDrop`), one history row tagged with both kinds.

Rejected alternatives: per-rule independent firing (2-3 near-identical banners per
drop, instantly fills the 3-slot stack — reads as a bug) and payload merging (catalog
entries stop being independent pure functions; information loss is near zero anyway
since payload bodies derive from the shared event).

**Amendment (soak #234, post-launch):** `whiteBag`/`orangeBag` no longer put the
item's name/enchant count in their payload by default — a bag glimpsed across the
room (possibly another player's) shouldn't spoil its contents. `body` is a generic
message and `icon` is the bag's own sprite; the real item is only revealed when the
same drop also fires `enchantedDrop` via a specific item-name or SlotType-category
override (the user explicitly asked to be told about that item/class). See
`docs/notifications.md`'s "Loot-bag spoiler avoidance" for the shipped mechanism —
this changes `AlertKind.match`'s signature to also receive the full
`NotificationsSettings` (§3's `match(event, params)` above is the original,
now-superseded shape).

## 4. Stage 3 — delivery

**Banner host** (`renderer/src/alerts/AlertToastHost.tsx`): rendered in `AppShell`
above `PanelCanvas`, top-center of the overlay window. Visible in both interactive and
hidden mode (same rationale as pinned panels — the whole point is notifying
mid-gameplay); `pointer-events-none` when hidden, click-to-dismiss when interactive.
Stack capped at 3 with a "+N more" line; each auto-dismisses after ~5 s.

**Sound** (`renderer/src/alerts/sound.ts`): one bundled CC0 ping (small `.ogg` under
`renderer/src/assets/`, imported through Vite) played via an `HTMLAudioElement`,
volume from settings. Implementation notes:

- Chromium's autoplay policy can block audio with no prior user gesture — Electron's
  `app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')` in the
  main process is the standard fix.
- Plays are coalesced to at most one ping per ~700 ms so an 8-item bag or a chat burst
  doesn't machine-gun.

**History**: the engine keeps a bounded session log (last ~200 fired alerts: time,
matched kind ids, payload), persisting across `MapInfoPacket` and cleared on overlay
detach —
exactly `LootTracker`'s session semantics. A new `notifications` entry in
`PANEL_REGISTRY` renders it (timestamp + icon + title/body rows). Added to
`defaultLayout()` — `mergeWithDefaults` already handles appearing for existing users
on upgrade. The panel is a pure viewer; deleting it from the layout doesn't stop
alerts.

## 5. Settings — schema and the per-panel gear

### Schema

A new typed slice of `OverlaySettings` (`shared/settings.ts`), persisted through the
existing `settings.json` / `get-settings` / `save-settings` / `settings-changed`
plumbing — zero new IPC:

```ts
notifications: {
  enabled: boolean              // master switch
  volume: number                // 0..1; 0 = mute
  rules: Record<string, {       // keyed by AlertKind.id
    enabled: boolean; banner: boolean; sound: boolean
    params?: Record<string, unknown>
  }>
}
```

Missing keys merge from catalog defaults at load (the `loadSettings` spread pattern
already does this shape of migration); unknown keys from removed catalog entries are
ignored. The engine holds the latest settings via `onSettingsChanged` and consults
them at match time, so saves apply live.

### The per-panel gear (generic mechanism)

- `PanelSpec` gains `settings?: ComponentType<PanelSettingsProps>`. `PanelFrame`'s
  header renders a gear button (interactive mode only, next to pin/size) **only when
  `spec.settings` is defined** — panels without settings show nothing.
- Clicking the gear flips the panel body in place to the settings view (frame-local
  state; gear highlighted; gear or a "Done" row flips back). Flip-in-place is chosen
  over a floating popover: no z-index/overflow fights with neighboring panels, and
  panel bodies already scroll.
- Each settings component owns its storage. The notifications one edits the
  `notifications` slice via `getSettings`/`saveSettings` with a short debounce —
  **apply-on-change**, no Save button (low-risk toggles; the separate ConfigWindow
  keeps its explicit Save for restart-coupled settings). Implementation check: the
  main-process `save-settings` handler should skip hotkey re-registration / attach
  side effects when those fields are unchanged — verify before wiring frequent saves
  through it.
- Notification config lives **only** behind the gear — not duplicated in ConfigWindow.
  The settings view: master toggle, volume slider with a "test ping" button, then one
  row per catalog entry (enable / banner / sound checkboxes + its params editor if
  one is registered in the UI-side `paramsEditors` map — rows are generated from the
  catalog, so a new entry gets its settings row for free).
- Future users of the same mechanism, no extra framework work: Loot panel (bag-type
  filter), DPS panel (column config).

## 6. Privacy/testability constraint on chat (important)

Two hard facts collide:

1. `CAPTURE_ALLOWED_TYPES` (`overlay/src/shared/capture.ts`) **deliberately excludes
   `TextPacket`** — bug captures go to public GitHub issues and chat includes DMs.
   That must not change.
2. The tripwire test (`overlay/test/allowlist.test.ts`) requires every consumer's
   `CONSUMED_ENVELOPE_TYPES` to be capture-retained, precisely so bugs stay
   reproducible.

Resolution: the engine declares its loot-side consumed types normally (all already
allowlisted), and `TextPacket` gets an **explicit, documented exemption** in the
tripwire test (the `ItemInfoProvider` precedent, but stated as a named exemption list
with the privacy rationale in the comment — deliberate, not forgotten).

Consequences accepted up front:

- Chat-rule bugs will never be reproducible from user bug captures or
  `recordSessionToDisk` recordings (both use the same allowlist).
- Chat regression tests use synthetic fixtures only, generated via a
  `FakePacketSource` extension (per CLAUDE.md: extend it rather than hand-roll fakes —
  add a periodic party-chat/local-chat emitter there).

**Must be verified before the chat rule is built:** what actually distinguishes a
*party* message on the wire. `TextPacket.recipient` is the obvious candidate, but its
exact value for party chat is a wire fact we don't have pinned, and
`PartyListMessagePacket` also exists in the stream — per the ground-truth rule,
guessing then testing against the same guess is exactly the loot-saga failure mode
(#105 → soaks #113/#122/#136/#144). Since chat is excluded from both capture paths,
verification uses the Status panel's **chat-probe** diagnostic (a shipped,
explicitly user-armed, local-only capture of exactly these types —
`docs/overlay-main-process.md` "Chat probe"): arm it, produce a scripted message
matrix in-game (local / party-from-self / party-from-other / guild / tell + a party
command), disarm, and read the field values off the NDJSON. The raw file stays on
the user's machine; only redacted shape facts (exact sentinel strings, usernames
removed) go into issue #222. This is why the phasing in §9 splits chat out.

## 7. Edge cases and guards

- **Reconnect/re-entry:** `LootTracker` clears per-instance logged slots on
  `MapInfoPacket`, so re-entering an instance where your bag still sits on the ground
  re-logs it — notifications inherit that (a duplicate white-bag ping in a rare
  scenario; acceptable, documented).
- **Startup burst:** the engine starts evaluating only after settings have loaded; the
  loot detector inherits `LootTracker`'s `pendingNewObjects` startup-race handling.
- **Self-chat:** the chat detector ignores messages where the sender is the local
  player (identity already resolved from `CreateSuccessPacket` — same source
  `DpsTracker` uses).
- **Spam:** sound coalescing (~700 ms) + banner cap (3 + overflow) + an optional
  per-kind `cooldownMs` in the catalog defaults (chat gets one, loot doesn't).

## 8. File map

New:

- `overlay/src/renderer/src/alerts/AlertEngine.ts`
- `overlay/src/renderer/src/alerts/catalog.ts`
- `overlay/src/renderer/src/alerts/types.ts`
- `overlay/src/renderer/src/alerts/sound.ts`
- `overlay/src/renderer/src/alerts/AlertToastHost.tsx`
- `overlay/src/renderer/src/alerts/AlertSettings.tsx`
- `overlay/src/renderer/src/alerts/paramsEditors.tsx` — UI-side per-kind params-editor
  registry (keeps the catalog React-free)
- `overlay/src/renderer/src/alerts/useAlertEngine.ts`
- `overlay/src/renderer/src/panels/NotificationsPanel.tsx`
- `overlay/src/renderer/src/alerts/slotTypeNames.ts` — the committed SlotType
  id → display-name table (provenance: facts-file clustering, see §3)
- bundled ping asset under `overlay/src/renderer/src/assets/`
- `docs/notifications.md` (+ `docs/README.md` index entry — new subsystem, doc
  required by repo policy)

Modified:

- `overlay/src/shared/settings.ts` — `notifications` schema slice
- `overlay/src/renderer/src/panels/registry.ts` — `settings?` field + panel entry
- `overlay/src/renderer/src/panels/PanelFrame.tsx` — gear + flip-in-place
- `overlay/src/renderer/src/panels/PanelCanvas.tsx` — default layout entry
- `overlay/src/renderer/src/App.tsx` — engine mount + toast host
- `overlay/src/renderer/src/loot/LootTracker.ts` — `onEntry` hook + tracked-bag-type
  set as a constructor parameter
- `overlay/test/allowlist.test.ts` — named `TextPacket` exemption
- `src/main/java/bridge/LootBagTypes.java` — all-color tables + per-item `slotTypes`
- `src/main/java/assets/IdToAsset.java` — parse item-level `SlotType`
- `src/main/java/bridge/FakePacketSource.java` — phase 1: an enchanted drop in a
  non-white/orange bag (seeded from the facts file, per the established pattern) to
  exercise all-color `enchantedDrop`; phase 2: chat emitter (after wire verification)
- `overlay/src/main/index.ts` — autoplay-policy switch
- `docs/overlay-renderer.md` (gear mechanism), `docs/overlay-testing.md`
  (chat-fixture caveat)

## 9. Phasing

1. **Phase 1** — engine + catalog + loot rules (white/orange/enchant-threshold incl.
   the `LootBagTypes` all-color widening and `SlotType` plumbing), toast host, sound,
   gear framework, Notifications panel, tests off existing loot fixtures + the
   extended `FakePacketSource`. Fully buildable headless today; no unverified wire
   facts (slot types come from the committed facts file).
2. **Phase 2** — chat: pin the party-channel wire shape from a live session first,
   then the detector, the `partyChat` catalog entry, and the `FakePacketSource` chat
   emitter matching the verified shape.

## 10. Open items

- Pin the party-chat wire shape (`TextPacket.recipient`? `PartyListMessagePacket`?)
  from a live session before building phase 2 — via the Status panel's chat-probe
  button (§6).
- Verify the `save-settings` main handler is cheap/idempotent for unchanged
  hotkey/title fields before adopting apply-on-change saves.
- Pick/produce the bundled ping sound (CC0, short, quiet-mix friendly).
- Measure the widened `lootBagTypes` envelope (~11.4k items vs today's ~1.8k); if
  it's heavy, dedupe `itemNames` against the `itemInfo` envelope's `names`.
- Check whether the real dump carries an official SlotType name table (extend
  `extractFacts` if so); otherwise commit the clustered id → name constant after
  review (§3).

## 11. Implementation plan

Filed as six dependency-ordered issues, each one agent PR into `staging`, sized to
be implementable and testable headless (FakePacketSource + vitest + gradle, no
game). The §1 layering contract is binding acceptance criteria in every one of them.

1. **#217 — Bridge: all-color loot metadata + item slot types** — the data layer:
   `LootBagTypes` widening + `slotTypes`, `IdToAsset` item-`SlotType` parsing,
   `LootTracker` tracked-set parameter + `onEntry`, `FakePacketSource` enchanted
   non-white/orange drop. Loot panel behavior explicitly unchanged.
2. **#218 — Alert engine core (no UI)** — engine, catalog (the three loot rules with
   tiered thresholds), dispatcher, fired-alert store, settings schema,
   `slotTypeNames`. Deliberately ships nothing visible: the store's subscribe API
   is the contract every UI surface builds on.
3. **#219 — Banner toast host + ping sound** — pure presentation over the store; the PR
   that establishes the "banner redesign touches `AlertToastHost` only" boundary.
4. **#220 — Notifications history panel** — a second, independent viewer over the store.
5. **#221 — Per-panel settings gear + notifications settings UI** — the generic gear
   mechanism plus its first user (params editors in the UI-side registry).
6. **#222 — Party-chat rule (phase 2)** — blocked on the §6 wire verification; the issue
   must carry the verified party-channel shape before `agent:build` is applied.

Label them (`agent:build`) **sequentially, each after the previous PR lands** —
every slice builds on the previous one's contract, and parallel siblings only feed
the rebase loop. This PRD must be merged (on `staging`, where build agents branch
from) before the first label is applied.
