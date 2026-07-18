# Notification system ("alerts")

Design doc: [prd-notifications.md](prd-notifications.md). This doc covers the
**shipped implementation** of issue #218 (the framework-agnostic core — event
detection, rule catalog, dispatcher, fired-alert store, settings schema),
issue #219 (the two delivery surfaces — a banner toast host and a ping
sound), and issue #220 (the Notifications history panel — a second,
independent viewer over the same store). The settings gear (issue #221 in
the PRD's §11 implementation plan) still builds on the same contract this
doc describes. Naming: the subsystem is `alerts` internally, "Notifications"
user-facing (PRD §1).

## Files

| File | Role |
| --- | --- |
| `overlay/src/renderer/src/alerts/types.ts` | `GameEvent` (currently just `loot-drop`), `AlertKind`, `AlertPayload`, `RuleSettings`, `FiredAlert`. |
| `overlay/src/renderer/src/alerts/catalog.ts` | `whiteBag`/`orangeBag`/`enchantedDrop` rule definitions, `CATALOG` (the banner-priority order), `resolveRuleSettings`. |
| `overlay/src/renderer/src/alerts/dispatcher.ts` | `dispatchEvent` — the multi-match resolution (cooldown filter, banner/sound/history semantics). |
| `overlay/src/renderer/src/alerts/store.ts` | `FiredAlertStore` — the bounded, subscribable fired-alert session log. |
| `overlay/src/renderer/src/alerts/AlertEngine.ts` | The framework-agnostic engine: owns a wide `LootTracker`, wires it through `dispatchEvent` into `store`. |
| `overlay/src/renderer/src/alerts/useAlertEngine.ts` | React hook mounting one `AlertEngine` at App level, wiring packet/settings/detach IPC. |
| `overlay/src/renderer/src/alerts/slotTypeNames.ts` | SlotType id → display name, empirically derived (see its own doc comment). |
| `overlay/src/shared/settings.ts` | `NotificationsSettings`/`NotificationRuleSettings` — the persisted schema slice. |
| `overlay/src/renderer/src/alerts/toastQueue.ts` | `ToastQueue` (issue #219) — framework-agnostic cap-3/overflow/auto-dismiss queue backing the banner host. |
| `overlay/src/renderer/src/alerts/sound.ts` | `PingPlayer`/`pingPlayer` (issue #219) — plays the bundled ping, coalesced to ≤1 per ~700ms. |
| `overlay/src/renderer/src/alerts/AlertToastHost.tsx` | The banner UI (issue #219) — the one file a future redesign touches (PRD §1). |
| `overlay/src/renderer/src/assets/sfx/ping.wav` | The bundled ping asset — a short synthesized tone (self-authored, CC0), imported through Vite. |
| `overlay/src/renderer/src/alerts/alertStoreContext.ts` | `AlertStoreContext`/`useAlertStore()` (issue #220) — exposes the App-level `AlertEngine.store` to panels mounted deep under `PanelCanvas`, with no direct parent/child relationship to `App.tsx`. |
| `overlay/src/renderer/src/panels/NotificationsPanel.tsx` | The history panel (issue #220) — a `PANEL_REGISTRY` entry rendering the store's session log, newest first. |
| `overlay/src/renderer/src/harness/alertGallerySeed.ts` | `seedGallery` (issue #219, reused by #220) — four representative fired alerts, shared by `AlertToastGalleryMount.tsx` and `harness/PanelMount.tsx`'s `notifications` case for `npm run shots`. |

## Architecture

```
packet batch ──► AlertEngine.ingest ──► LootTracker.onEntry ──► GameEvent
                                                                    │
                                                                    ▼
                                              dispatchEvent(event, CATALOG, settings)
                                                                    │
                                          ┌─────────────────────────┼─────────────────────┐
                                          ▼                         ▼                     ▼
                                   banner payload              sound flag          FiredAlertStore.append
                                          │                         │             (banner/sound flags
                                          ▼                         ▼              included, issue #219)
                                                AlertToastHost (issue #219, App.tsx)
                                          │                         │
                                          ▼                         ▼
                                    ToastQueue                 pingPlayer.play
                              (cap 3 + overflow,           (coalesced ≤1/~700ms,
                               auto-dismiss ~5s)             sound.ts)
```

`AlertEngine` is deliberately in the exact mold of `DpsTracker`/`LootTracker`
(see `docs/overlay-renderer.md` §5/§7): a plain class with `ingest(packets)`,
`reset()`, and a declared `CONSUMED_ENVELOPE_TYPES`. It owns a **private**
`LootTracker` instance constructed with a wide, static superset of BagType ids
(`ALL_BAG_TYPES`, `AlertEngine.ts`) — not the Loot panel's narrow `[6, 8]` — so
it sees a drop in *any* bag color, reusing `LootTracker`'s existing bag-parsing
logic entirely rather than re-implementing it. Each new `LootEntry` (via
`onEntry`, issue #217) becomes a `loot-drop` `GameEvent`
(`itemType`/`itemName`/`bagType`/`slotType`/`enchantCount`/`enchantCode`) —
`enchantCount` is `LootEntry.rarity`, which already *is* the filled-enchant
count (`sprites/enchantRarity.ts`'s `slotRarityTier`), so no separate
enchant-counting logic is needed here.

## The layering contract (PRD §1 — binding)

`types.ts`, `catalog.ts`, `dispatcher.ts`, `store.ts`, `AlertEngine.ts`, and
`toastQueue.ts` import **nothing** from React or any component/UI module —
every test for them (`overlay/test/alerts-*.test.ts`) runs in vitest's plain
`node` environment, no DOM. `sound.ts` is also React-free but does touch the
DOM (`HTMLAudioElement`) — deliberately narrowed behind its own `PingAudio`
interface so tests inject a mock and never construct a real `Audio`.
`useAlertEngine.ts` and `AlertToastHost.tsx` are the only files that touch
React; `AlertToastHost.tsx` is exactly the file issue #219 predicted a banner
UI would live in, and it's the only one a future redesign needs to touch — a
future history panel (issue #220) reads only `engine.store`'s subscribe API,
neither ever reaching into `AlertEngine` internals or the dispatcher.

**Extensibility.** Adding a new notification is exactly one more entry in
`CATALOG` (`catalog.ts`) — the dispatcher and store need zero changes. Proved
directly: `test/alerts-engine.test.ts`'s "a synthetic catalog entry fires
end-to-end" test constructs an `AlertEngine` with
`new AlertEngine({ catalog: [...CATALOG, syntheticKind] })` and asserts the
synthetic kind's id reaches `engine.store.getAll()[0].matchedKindIds` with no
edits to `dispatcher.ts` or `store.ts`.

## The rule catalog (`catalog.ts`)

Each `AlertKind` is `{ id, title, eventType, defaults, cooldownMs?, match }`.
`match(event, params)` is a pure function returning an `AlertPayload` (`{
title, body, icon? }`) or `null`. `AlertKind` is deliberately **not** generic
over the event/params type — every kind's `match` accepts the full `GameEvent`
union and `Record<string, unknown>` params, narrowing internally (the same
cast-at-the-boundary pattern this codebase already uses for wire-data
envelopes, e.g. `env.data as XxxData`). This keeps `CATALOG` a single
homogeneous array with no variance workarounds.

**v1 rules**, in `CATALOG`'s (banner-priority) order:

1. **`whiteBag`** — fires on any `loot-drop` with `bagType === 6`.
2. **`orangeBag`** — fires on any `loot-drop` with `bagType === 8`.
3. **`enchantedDrop`** — fires on a `loot-drop` in **any** bag color once
   `enchantCount` meets an effective threshold, resolved most-specific-wins:
   `itemOverrides[name.toLowerCase()] ?? slotTypeOverrides[slotType] ?? tier`
   (default `tier = 4`, divine). Item-name matching is case-insensitive exact
   (`"Doom Bow Shiny"` does **not** match an override keyed `"doom bow"`).

`resolveRuleSettings(kind, settings)` merges a user's
`NotificationsSettings.rules[kind.id]` onto `kind.defaults`
**field-by-field** — `enabled`/`banner`/`sound` each fall back independently,
and `params` is a shallow object merge (`{ ...kind.defaults.params,
...raw.params }`), so setting only `enchantedDrop`'s `tier` in settings still
gets the catalog's default (empty) `slotTypeOverrides`/`itemOverrides`. A
`rules` entry for a removed catalog id is simply never read — nothing
iterates `settings.rules` directly, only `CATALOG.map(resolveRuleSettings)`.

## Multi-match semantics (`dispatcher.ts`, PRD §3)

`dispatchEvent(event, catalog, settings, now, lastFiredAt)`:

1. If `settings.enabled` is false, returns `null` immediately.
2. Evaluates every catalog rule whose `eventType` matches the event, skipping
   a disabled rule (`resolveRuleSettings(kind, settings).enabled`) or one
   whose `match()` returns `null`. A rule that matched but is still within its
   own `cooldownMs` (tracked per-kind-id in the caller-owned `lastFiredAt`
   map) is dropped too. No survivors → returns `null`.
3. **Banner:** the payload of the first survivor *in catalog order* whose
   resolved settings want a banner. If no survivor wants one, `result.banner`
   is `null` but `result.payload` still holds the first survivor's payload
   (so the fired-alert log always has something to display, even when every
   surviving match is sound-only).
4. **Sound:** `result.sound` is `true` iff *any* survivor wants one (never one
   ping per rule — see the PRD's rejected-alternatives note).
5. **History:** `result.matchedKindIds` lists every survivor's id, in catalog
   order — not just the one whose payload is shown.

Worked example (also a unit test,
`test/alerts-dispatcher.test.ts`): a divine white-bag drop with `whiteBag` set
banner-only and `enchantedDrop` set sound-only survives both. `matchedKindIds`
is `['whiteBag', 'enchantedDrop']`; the banner shown is `whiteBag`'s payload
(the only banner-wanting survivor, and first in catalog order); `sound` is
`true` (from `enchantedDrop`); one `FiredAlertStore` entry carries both kind
ids.

## The fired-alert store (`store.ts`)

`FiredAlertStore` is a bounded (`MAX_HISTORY = 200`, oldest evicted first)
session log with `append`/`getAll`/`subscribe`/`reset`. It **persists across
`MapInfoPacket`** — `AlertEngine.ingest` only ever forwards packets into
`LootTracker.ingest`, which handles its own per-instance reset internally;
nothing in `AlertEngine` reacts to `MapInfoPacket` directly, so the store is
never touched by it. `AlertEngine.reset()` (overlay detach / game close)
clears `store` (and the internal `LootTracker` + cooldown map) — the same
detach-only-reset contract `LootTracker`/`DpsTracker` already follow.

Each `FiredAlert` (`types.ts`) also carries `banner`/`sound` booleans (issue
#219 addition) — `AlertEngine.onLootEntry` passes
`result.banner !== null`/`result.sound` from the `DispatchResult` straight
through to `store.append`, so a UI surface can tell "this alert wants a
banner" apart from "this alert only wants a sound" without recomputing
`dispatchEvent`. `FiredAlertStore.append`'s `banner`/`sound` parameters
default to `true` so issue #218's original call sites (and every test
predating #219) don't need updating.

## Delivery (`AlertToastHost.tsx`, `sound.ts`, `toastQueue.ts` — issue #219)

`AlertToastHost` is rendered once in `App.tsx`'s `AppShell`, above
`PanelCanvas`, fed `engine.store` and the live `notifications.volume`
(`useAlertEngine.ts` now returns `{ engine, volume }` — it already tracked
`onSettingsChanged` for the engine, so exposing the same value avoids a
second subscription). It watches `store.subscribe` for alerts it hasn't seen
yet (a `seenIds` ref, seeded from `store.getAll()` at mount so a remount with
a non-empty session log doesn't replay history as fresh toasts): each new
alert with `banner: true` is pushed into a `ToastQueue`; each with
`sound: true` plays through `pingPlayer`. This is the one place both
channels are triggered from a fired alert — `store`/`types` stay React-free
(the layering contract above), only this consuming component touches the
DOM/audio.

**`ToastQueue`** (`toastQueue.ts`) is a plain, framework-agnostic class
(same testability rationale as `FiredAlertStore`): capped at 3 simultaneous
visible toasts (PRD §4); a `push` beyond the cap waits in a FIFO `pending`
queue instead of being dropped, and is promoted into a freed slot the moment
an older toast auto-dismisses (`setTimeout`, ~5s, real wall-clock time — not
tied to packet/game time, since these are purely transient session UI) or is
clicked away (`dismiss`, interactive mode only). `dispose()` clears both the
timers AND the visible/pending arrays — not just the timers — so a torn-down
instance is genuinely empty rather than leaving stale entries a remount
would inherit with no timers left to ever clear them (found via React
StrictMode's dev-only double-invoke of effects during
`AlertToastGalleryMount`'s harness testing — a real unmount/remount would hit
the identical bug otherwise).

**`sound.ts`** wraps a real `HTMLAudioElement` playing the bundled
`assets/sfx/ping.wav` (a short synthesized tone, self-authored so it's
unambiguously CC0 — see the PRD's asset note) behind a narrow `PingAudio`
interface (`{ volume, play() }`) so tests inject a mock and never touch the
DOM. `PingPlayer.play(volume, now?)` mutes entirely at `volume <= 0` (no
audio element even constructed) and coalesces to at most one play per
~700ms, mirroring `dispatcher.ts`'s pattern of an injectable `now` for
testability (production call sites never pass it). The app-wide singleton
`pingPlayer` is what `AlertToastHost` calls through, so coalescing is global
across every matched event, not per-component.

**Autoplay.** A fired alert is a game event, not a user click, so Chromium's
default autoplay policy would block the ping with no prior gesture.
`main/index.ts` adds `app.commandLine.appendSwitch('autoplay-policy',
'no-user-gesture-required')` before `app.whenReady()` — the standard fix.
`sound.ts`'s own `.catch(() => {})` on the underlying `play()` promise is
defensive belt-and-suspenders, not the actual fix.

**Toast gallery shot.** `AlertToastHost` isn't a `PANEL_REGISTRY` entry (an
App-level singleton, not a draggable/resizable panel), so it doesn't fall out
of `npm run shots`' per-panel loop automatically. `harness/
AlertToastGalleryMount.tsx` (mounted via `?toastGallery=1`) seeds a
`FiredAlertStore` directly (via `harness/alertGallerySeed.ts`'s `seedGallery`)
with four representative banner-worthy alerts — no packet fixture needed,
since the store's public API is all `AlertToastHost` ever reads — producing
the cap-3 + "+1 more" overflow shot at
`docs/screenshots/panels/alertToastHost-gallery.png`. See
`docs/overlay-harness.md` for the harness mount-mode convention this follows.

## History panel (`NotificationsPanel.tsx` — issue #220)

A second, independent viewer over `engine.store`, unlike `AlertToastHost`
this one **is** an ordinary `PANEL_REGISTRY` entry (`registry.ts`'s
`notifications` key) — draggable/resizable/closable-off-the-canvas exactly
like any other panel, added to `PanelCanvas.tsx`'s `defaultLayout()` so
existing users get it on upgrade via `panelLayout.ts`'s `mergeWithDefaults`
(`test/panelCanvas-notifications.test.ts`).

Reads the store through `alertStoreContext.ts`'s `AlertStoreContext`/
`useAlertStore()` rather than a prop — `NotificationsPanel` is mounted by
registry lookup deep under `PanelCanvas`, with no direct parent/child
relationship to `App.tsx` (the same rationale as
`dps/dpsDetailContext.ts`). `App.tsx` provides the context around `AppShell`
with the same `alertEngine.store` instance already passed to
`AlertToastHost` as a prop, so both surfaces watch the identical store.
`NotificationsPanel` imports nothing from `AlertEngine`/`catalog`/
`dispatcher`, and no packet type — only the store's subscribe API and
`FiredAlert` (PRD §1 layering contract, binding for every notification-
system UI surface).

Renders the session log newest-first: each row shows the fired time, the
payload's `icon` via `ItemSprite` when set, title/body, and (hidden at `sm`,
no room) the full `matchedKindIds` list — the history is where "why did this
fire" is fully visible even though a banner only ever shows one payload (PRD
§3 point 4). Empty state uses the shared `EmptyState`. Because the panel only
reads the store, deleting it from the layout doesn't stop alerts firing —
same "pure viewer" property `LootPanel` has over `LootTracker`.

Persistence/reset are entirely the store's own semantics (`store.ts`,
above) — the panel adds no logic of its own here, so
`test/notificationsPanel.test.ts` asserts them through the identical
`getAll`/`subscribe`/`reset` calls the panel's data-source effect makes,
rather than duplicating `alerts-store.test.ts`'s lower-level coverage.

**Panel gallery shot.** Unlike `AlertToastHost`, this panel *is* a
`PANEL_REGISTRY` entry, so `npm run shots` picks it up automatically through
the normal per-panel loop (`harness/PanelMount.tsx`) — no dedicated harness
mount mode needed. `PanelMount` seeds a `FiredAlertStore` with the same
`alertGallerySeed.ts`'s `seedGallery` used by the toast gallery (only for
`type === 'notifications'`; every other panel type gets an empty, harmless
store — the same unconditional-but-idle provider pattern already used there
for Sprite/EntityRegistry/ItemInfo) and provides it via `AlertStoreContext`,
producing `docs/screenshots/panels/notifications-{sm,md,lg}.png`.

## Settings (`shared/settings.ts`)

```ts
interface NotificationsSettings {
  enabled: boolean                              // master switch
  volume: number                                 // 0..1; 0 mutes (issue #219's pingPlayer)
  rules: Record<string, NotificationRuleSettings> // keyed by AlertKind.id
}
interface NotificationRuleSettings {
  enabled: boolean
  banner: boolean
  sound: boolean
  params?: Record<string, unknown>
}
```

`DEFAULT_SETTINGS.notifications` is `{ enabled: true, volume: 1, rules: {} }`
— deliberately **not** pre-populated with each catalog kind's defaults, so
`shared/settings.ts` (loaded by both the main and renderer processes) has no
dependency on the renderer-only `alerts/catalog.ts` module. Per-kind defaults
are applied lazily, at match time, by `resolveRuleSettings` — see "The rule
catalog" above. `useAlertEngine.ts` calls `engine.setSettings(settings)` on
initial `getSettings()` and on every `onSettingsChanged` push, so a settings
change applies to the very next matched event with no engine restart
(`test/alerts-engine.test.ts`'s "picks up settings-changed pushes live" test).

## SlotType names (`slotTypeNames.ts`)

See the file's own doc comment for the full derivation. Summary: every
playable class ships 3-4 starter "ST" test items in the committed facts file
(`<Class>ST<n>`, n = weapon/ability/armor/ring), which pins each class's own
weapon/ability/armor SlotType id with no guessing; clustering the facts
file's item names within each resulting id then confirms the human-facing
category name. `test/alerts-slotTypeNames.test.ts` spot-checks this against
the live facts file (e.g. every real item named `"Wand of ..."` maps to id 8,
named `"Wand"`).

## How to add a new notification

Almost always **one new entry in `CATALOG`** (`catalog.ts`):

```ts
export const myNewRule: AlertKind = {
  id: 'myNewRule',
  title: 'My New Rule',
  eventType: 'loot-drop',           // or a future event type
  defaults: { enabled: true, banner: true, sound: true, params: {} },
  match: (event, params) => {
    if (event.type !== 'loot-drop') return null
    // ... your predicate ...
    return { title: '...', body: '...', icon: event.itemType }
  }
}
export const CATALOG: readonly AlertKind[] = [whiteBag, orangeBag, enchantedDrop, myNewRule]
```

No change is needed to `dispatcher.ts`, `store.ts`, or `AlertEngine.ts` — the
extensibility test above proves this end-to-end. A rule needing typed params
(like `enchantedDrop`) defines its own params interface in `catalog.ts` and
casts `rawParams` to it inside `match`, same as `enchantedDrop` does. A rule
with a params **editor UI** additionally registers one in
`alerts/paramsEditors.tsx` (issue #221 — doesn't exist yet).

Only a genuinely **new event kind** (not just a new rule over an existing
one) requires touching `types.ts` (`GameEvent`) and `AlertEngine.ts` (a new
detector, or an existing tracker's `onEntry`-style hook) — see the PRD §2
distinction between "detectors" and "catalog entries".
