# Notification system ("alerts")

Design doc: [prd-notifications.md](prd-notifications.md). This doc covers the
**shipped implementation** of issue #218 (the framework-agnostic core — event
detection, rule catalog, dispatcher, fired-alert store, settings schema),
issue #219 (the two delivery surfaces — a banner toast host and a ping
sound), issue #220 (the Notifications history panel — a second, independent
viewer over the same store), issue #221 (the per-panel settings gear —
`overlay-renderer.md` §2's "Per-panel settings gear" covers the generic
mechanism; this doc covers its first user, the Notifications panel's
settings view), and issue #222 (the `partyChat` rule — phase 2, the first
consumer of a `chat` `GameEvent`, gated on the party-channel wire shape
pinned via the Status panel's chat-probe diagnostic, see "Chat detector &
`partyChat`" below). Naming: the subsystem is `alerts` internally,
"Notifications" user-facing (PRD §1).

## Files

| File | Role |
| --- | --- |
| `overlay/src/renderer/src/alerts/types.ts` | `GameEvent` (`loot-drop` \| `chat`), `AlertKind`, `AlertPayload`, `RuleSettings`, `FiredAlert`. |
| `overlay/src/renderer/src/alerts/catalog.ts` | `whiteBag`/`orangeBag`/`enchantedDrop`/`partyChat` rule definitions, `CATALOG` (the banner-priority order), `resolveRuleSettings`. |
| `overlay/src/renderer/src/alerts/chatTypes.ts` | (issue #222) `TextPacketData`/`CreateSuccessPacketData`/`UpdatePacketData` wire shapes the chat detector reads, plus `classifyChatChannel` — the pure function classifying `TextPacket.recipient` into `ChatEvent.channel`. |
| `overlay/src/renderer/src/alerts/dispatcher.ts` | `dispatchEvent` — the multi-match resolution (cooldown filter, banner/sound/history semantics). |
| `overlay/src/renderer/src/alerts/store.ts` | `FiredAlertStore` — the bounded, subscribable fired-alert session log. |
| `overlay/src/renderer/src/alerts/AlertEngine.ts` | The framework-agnostic engine: owns a wide `LootTracker`, wires it through `dispatchEvent` into `store`; also runs the chat detector directly (issue #222 — no existing tracker to delegate to). |
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
| `overlay/src/renderer/src/alerts/AlertSettings.tsx` | `NotificationsSettingsView` (issue #221) — the Notifications panel's settings view (`registry.ts`'s `settings` field); the per-panel gear mechanism's first user. |
| `overlay/src/renderer/src/alerts/settingsRows.ts` | `buildRuleRows()` (issue #221) — React-free: one row per `CATALOG` entry with its resolved `RuleSettings`, so a new catalog entry needs no settings-UI edit (`test/alerts-settingsRows.test.ts` proves this with a synthetic entry). |
| `overlay/src/renderer/src/alerts/paramsEditors.ts` | `PARAMS_EDITORS` (issue #221) — the UI-side `AlertKind.id → ComponentType<ParamsEditorProps>` registry (PRD §3). Only imports pre-built editor components itself — never defines one — so it can export a non-component value without tripping `react-refresh/only-export-components`. |
| `overlay/src/renderer/src/alerts/paramsEditorTypes.ts` | `ParamsEditorProps` (issue #221) — split into its own type-only file so `paramsEditors.ts` and an editor component never need a value import from each other. |
| `overlay/src/renderer/src/alerts/EnchantedDropParamsEditor.tsx` | `enchantedDrop`'s params editor (issue #221, PRD §3): tier dropdown + add/remove SlotType-category and item-name override rows. Registered under `paramsEditors.ts`. Its item-name suggestion dropdown is debounced and portaled to `document.body` (soak #234 - see `itemNameSearch.ts` and below). |
| `overlay/src/renderer/src/alerts/useItemNameCatalog.ts` | `useItemNameCatalog()` (issue #221) — every distinct name from the bridge's `lootBagTypes.itemNames` (issue #217's widened, all-color table), for the item-override autocomplete. A standalone `onPacketBatch` subscription, not routed through `AlertEngine`'s internal `LootTracker` — a UI-only concern outside the layering contract below. Because it mounts with the settings view — after the bridge's one-shot, edge-triggered delivery (#239) — it requests `replayMetadata()` on mount (issue #245, `docs/overlay-main-process.md` "Metadata replay") and skips same-`metaVersion` re-deliveries. |
| `overlay/src/renderer/src/alerts/PartyChatParamsEditor.tsx` | `partyChat`'s params editor (issue #222): a plain add/remove keyword-list editor — no autocomplete, keywords are free text — plus a cooldown-seconds field (issue #269). Registered under `paramsEditors.ts`. |

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

The chat path (issue #222) runs the same `ingest → GameEvent → dispatchEvent
→ store` pipeline the diagram above shows for loot, just without a
`LootTracker`-equivalent sub-tracker in between: `ingest()` handles
`CreateSuccessPacket`/`UpdatePacket`/`TextPacket` directly and turns a
non-self `TextPacket` straight into a `chat` `GameEvent` — see "Chat detector
& `partyChat`" below.

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
`match(event, params, settings)` is a pure function returning an
`AlertPayload` (`{ title, body, icon? }`) or `null`. `settings` is the full
live `NotificationsSettings`, not just this kind's own resolved `params` —
most rules never touch it (`enchantedDrop` doesn't), but `whiteBag`/
`orangeBag` consult it to check whether `enchantedDrop` *also* matched this
event via a specific override (see "Loot-bag spoiler avoidance" below).
`AlertKind` is deliberately **not** generic over the event/params type —
every kind's `match` accepts the full `GameEvent` union and
`Record<string, unknown>` params, narrowing internally (the same
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
4. **`partyChat`** (issue #222) — fires on a `chat` event whose `channel` is
   `'party'`, optionally filtered by a `keywords: string[]` param (empty =
   every party message; non-empty = case-insensitive **whole-word** match
   against `ChatEvent.text` — never `cleanText`, the profanity-filtered
   display variant — `"w4"` matches `"pull w4"` but not `"w40k"`, issue #269).
   Default **off** (chat notifications are opt-in, unlike the loot trio) with
   a 15000ms `cooldownMs` seed (raised from the original 3000ms — issue #269,
   too short to actually suppress a chat burst) — chat can burst in a way a
   single loot drop never does. User-adjustable per rule via
   `PartyChatParams.cooldownMs` (`PartyChatParamsEditor.tsx`'s cooldown field);
   `dispatcher.ts`'s `resolveCooldownMs` prefers that override and falls back
   to the catalog seed when unset. See "Chat detector & `partyChat`" below for
   the detector itself and its privacy/testing constraints.

### Loot-bag spoiler avoidance (`whiteBag`/`orangeBag`, soak #234)

A white/orange bag can belong to another player, or sit on the ground before
you've walked over to check it, so its payload does **not** reveal what's
inside by default: `body` is the generic `"A new bag has dropped."` and
`icon` is the bag's own ground-bag sprite (`LootDropEvent.bagIcon`,
`LootTracker.bagIcon(bagType)` — `null` until the `lootBagTypes` envelope
first resolves it, in which case no `icon` is set at all) rather than
`itemType`.

The one exception: if the same drop *also* fires `enchantedDrop` via an
item-name or SlotType-category override (not just the global `tier`), the
payload reveals the real item — name, enchant count, its own icon — via the
shared `describeItem` formatter. The reasoning: the user explicitly
configured that override for a particular item or class, so hiding it there
would defeat the point, whereas the global tier says nothing item-specific
and stays hidden. `catalog.ts`'s `matchesSpecificOverride` implements this
check (reusing `enchantedDrop`'s own `resolveEnchantedDropThreshold`, so the
two rules' resolution logic can't drift), and returns `false` outright if
`enchantedDrop` itself is disabled — a user who turned that rule off entirely
never gets a spoiler through this path either.

`AlertEngine.onLootEntry` populates `bagIcon` on every `loot-drop` event from
its own `LootTracker` instance (`this.lootTracker.bagIcon(entry.bagType)`),
independent of `itemType` — see "Architecture" above.

`resolveRuleSettings(kind, settings)` merges a user's
`NotificationsSettings.rules[kind.id]` onto `kind.defaults`
**field-by-field** — `enabled`/`banner`/`sound` each fall back independently,
and `params` is a shallow object merge (`{ ...kind.defaults.params,
...raw.params }`), so setting only `enchantedDrop`'s `tier` in settings still
gets the catalog's default (empty) `slotTypeOverrides`/`itemOverrides`. A
`rules` entry for a removed catalog id is simply never read — nothing
iterates `settings.rules` directly, only `CATALOG.map(resolveRuleSettings)`.

## Chat detector & `partyChat` (issue #222)

The first (and, as of this issue, only) consumer of the `chat` `GameEvent` —
proving the PRD §1 extensibility claim "a genuinely new event kind needs a
detector; a new rule over an existing kind needs neither." Unlike loot, there
is no existing chat tracker to delegate to, so `AlertEngine` runs the
detector directly rather than owning a private sub-tracker instance.

**Wire shape** (pinned 2026-07-18 from a live-session capture via the Status
panel's chat-probe diagnostic — `docs/overlay-main-process.md` "Chat probe",
PR #231 — see `docs/prd-notifications.md` §6 for why this had to be verified
rather than assumed):

| channel | `TextPacket.recipient` | `objectId` | notes |
| --- | --- | --- | --- |
| party (another member) | `"*Party*"` — exact literal sentinel, asterisks included | `-1` | sender may not be in the local object space; `numStars`/`starBackground` populated |
| local/world | `""` (empty string) | sender's live entity id | |

Guild and `/tell` sentinels were not sampled (out of scope for this issue) —
`chatTypes.ts`'s `classifyChatChannel` classifies anything besides the two
verified shapes as `'unknown'` rather than guessing at an unverified
sentinel, so a future guild/PM rule can't silently misfire against the wrong
shape. No party-specific packet (`PartyListMessagePacket` etc.) appeared
alongside the sampled party messages — party chat travels as plain
`TextPacket`, so no other packet type is consulted.

**Local-player identity & self-ignore.** `AlertEngine` resolves "who is the
local player" the same two-source way `DpsTracker.ts` does:
`CreateSuccessPacket.objectId` for *which* entity is "you", and
`UpdatePacket`'s `NAME_STAT` roster (stripped of the `,titleCode` suffix,
same as `DpsTracker.ts`) for *what name* that objectId currently carries.
`onChatMessage` strips that same `,titleCode,...` suffix off `TextPacket.name`
too (`stripTitleCode`, issue #269 — a titled sender's `name` arrives as
`"Username,<titleCode>,<titleCode>"`, and previously reached both the
self-ignore check and the displayed sender unstripped) before comparing it
against the resolved local-player name and before setting `ChatEvent.sender`
— so a titled local player's own party message is still recognized as self,
and a titled other player's banner/history sender shows the bare username,
never the raw title-code suffix. `onChatMessage` then ignores a `TextPacket`
whose (now-stripped) name equals the resolved local-player name — **matched
by name, never `objectId`**, because a party sender arrives with
`objectId: -1` regardless of who sent it (whether a self-sent party message
even echoes back as a `TextPacket` was not sampled; name-based self-ignore is
correct either way — a harmless no-op if there's no echo). This identity
state lives in `AlertEngine` itself (`localPlayerId`,
`entityNames`), separate from `DpsTracker`'s own copy — the two trackers are
independent consumers of the same wire facts, not wired together. It's
cleared only on `reset()` (overlay detach), not on `MapInfoPacket` — the same
local player is still logged in across an instance change, so re-deriving it
every map would be pure churn.

**Privacy/testing constraint (PRD §6, binding).** `overlay/src/shared/capture.ts`'s
`CAPTURE_ALLOWED_TYPES` deliberately excludes `TextPacket` — bug captures go
to public GitHub issues and the session recorder writes to a user's own disk,
and chat includes DMs. `AlertEngine.CONSUMED_ENVELOPE_TYPES` still declares
`TextPacket` (it genuinely consumes it), so `overlay/test/allowlist.test.ts`
carries a **named, documented exemption** for it rather than silently
skipping the tripwire or "fixing" it by widening the allowlist — see that
test's own doc comment and `docs/overlay-testing.md`'s allowlist section.
Consequences accepted up front (PRD §6): `partyChat` bugs are never
reproducible from a user's bug-report capture or session recording — every
`partyChat` regression test uses a synthetic fixture built from
`FakePacketSource`'s chat cycle instead (`overlay/test/alerts-engine.test.ts`,
`overlay/test/alerts-chatTypes.test.ts`) — see `docs/overlay-testing.md`'s
chat caveat.

## Multi-match semantics (`dispatcher.ts`, PRD §3)

`dispatchEvent(event, catalog, settings, now, lastFiredAt)`:

1. If `settings.enabled` is false, returns `null` immediately.
2. Evaluates every catalog rule whose `eventType` matches the event, skipping
   a disabled rule (`resolveRuleSettings(kind, settings).enabled`) or one
   whose `match()` returns `null`. A rule that matched but is still within its
   effective cooldown (tracked per-kind-id in the caller-owned `lastFiredAt`
   map) is dropped too — `resolveCooldownMs(kind, rule.params)` (issue #269)
   prefers a numeric `cooldownMs` in the rule's *resolved* params (the only v1
   user of this today is `partyChat.cooldownMs`) over the catalog's static
   `AlertKind.cooldownMs` seed, so a per-rule override needs no dispatcher
   changes for a future kind either. No survivors → returns `null`.
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

## Settings gear (`AlertSettings.tsx` — issue #221)

The Notifications panel's `PanelSpec.settings` entry (`registry.ts`), the
first user of the generic per-panel gear mechanism —
`docs/overlay-renderer.md` §2's "Per-panel settings gear" covers the
mechanism itself (the gear button, the frame-local flip, `PanelSettingsProps`);
this section covers what the Notifications panel puts behind it.

`NotificationsSettingsView` owns its own storage (PRD §5): on mount it loads
the full `OverlaySettings` via `getSettings()` (keeping the whole object,
not just the `notifications` slice, in a ref) and subscribes
`onSettingsChanged` so an edit made elsewhere (e.g. `ConfigWindow`, a
different window) while this view is open is folded into the next save
instead of clobbered. Every edit updates local state immediately and writes
back via `saveSettings()` after a short (300ms) debounce — apply-on-change,
no Save button, same rationale as the rest of PRD §5.

The view renders, top to bottom:

- A master **enabled** checkbox (`NotificationsSettings.enabled`).
- A **volume** slider plus a **"Test ping"** button. The button dynamically
  `import()`s `./sound` at click time rather than statically importing
  `pingPlayer` — `sound.ts` statically imports the bundled `.wav` asset,
  and `registry.ts` (which now reaches `AlertSettings.tsx` via the
  `notifications` panel's `settings` field) is evaluated directly by
  `e2e/shots.spec.ts`'s top-level `PANEL_REGISTRY` loop, which Playwright's
  Node-based test collector runs with no Vite asset transform — a static
  binary-file import in that reachable path fails to parse. The dynamic
  import keeps `sound.ts` out of that eagerly-resolved graph entirely, with
  no change to `sound.ts` itself.
- One row per `CATALOG` entry, generated by `settingsRows.ts`'s
  `buildRuleRows(CATALOG, notifications)` — a React-free function returning
  `{ kindId, title, settings: RuleSettings }[]`, so a future catalog entry
  needs zero settings-UI edits to get a row (`test/alerts-settingsRows.test.ts`
  proves this with a synthetic entry, mirroring `AlertEngine`'s own
  extensibility test). Each row shows the kind's title and enable/banner/
  sound checkboxes **stacked below the title, not beside it** — a 220px `sm`
  panel can't fit a title plus three labeled checkboxes on one line without
  squeezing both unreadable (see the `notifications-sm-settings.png` gallery
  shot's git history for the before/after). Editing a checkbox writes
  `rules[kindId]` via `updateRule()`, seeded from the row's already-resolved
  settings (catalog defaults + any existing override) on first edit so a
  toggle never loses the kind's other fields.
- If `paramsEditors.ts`'s `PARAMS_EDITORS` has an entry for that row's
  `kindId`, its editor renders below the checkboxes. Only `enchantedDrop`
  has one today (`EnchantedDropParamsEditor.tsx`): a global tier dropdown
  (rarity names — uncommon/rare/legendary/divine — not numbers, per PRD §3)
  plus add/remove override rows for SlotType categories (`slotTypeNames.ts`)
  and item names (autocomplete via `useItemNameCatalog()` over the widened
  `lootBagTypes.itemNames`, stored lowercased on commit — matching
  `enchantedDrop.match`'s case-insensitive lookup in `catalog.ts`). Kept in
  its own file (`paramsEditors.ts` only imports it, never defines a
  component itself) for the same `react-refresh/only-export-components`
  reason `registry.ts` stays free of local component definitions:
  `PARAMS_EDITORS` is a non-component export, and Vite's fast-refresh plugin
  requires every export of a component-containing file to itself be a
  component.
- A **Done** button (`onDone`, from `PanelSettingsProps`) at the bottom,
  flipping the panel back to its normal content — the same effect as
  clicking the gear again.

**Item-name suggestion dropdown (soak #234).** Two fixes over the original
issue #221 shipped shape:

- **Performance.** `itemNameSearch.ts`'s `fuzzySearchItemNames` scores every
  name in the ~11.4k-entry catalog against the query on every call, so
  `EnchantedDropParamsEditor` now (a) refuses to search below
  `MIN_QUERY_LENGTH` (3) characters — a 1-2 character query matches
  thousands of names anyway, a useless ranking for the worst-case scoring
  cost — and (b) debounces the query by `SEARCH_DEBOUNCE_MS` (150ms) before
  re-running the search, so a fast typist doesn't trigger a full rescan on
  every keystroke.
- **Clipping.** The suggestion list used to be `position: absolute` inside
  the input's own wrapper, which `PanelFrame`'s ancestry clips: its content
  wrapper is `overflow-auto` (the frame itself `overflow-hidden` —
  `docs/overlay-renderer.md` §2), so a dropdown that extends past the panel's
  own edge — nearly guaranteed for a `sm`/`md` Notifications settings panel —
  was cut off. It's now portaled to `document.body` and positioned via
  `getBoundingClientRect` against the real input, the same pattern
  `ui/Tooltip.tsx` already uses to escape the identical clipping: opens
  upward instead of downward when there isn't room below, and is
  viewport-clamped either way, so it can never be cut off by an ancestor's
  overflow again.

The whole view is a single flat flow (no nested `overflow-y-auto`) so
`PanelFrame`'s own content wrapper is the sole scroll container — matching
every other panel body, and load-bearing for `e2e/shots.spec.ts`'s
below-the-fold clip detection, which only measures that outer wrapper; an
earlier version nested a second scrollport for the rule-row list and the
below-the-fold check couldn't see it clip, producing a silently-incomplete
`sm` shot with no `-full` variant to signal the gap.

**Panel gallery shots.** `e2e/shots.spec.ts` mounts every `PANEL_REGISTRY`
entry whose `spec.settings` is defined (only `notifications` today) a second
time via the harness's `&settings=1` flag (`PanelMount.tsx`/`mount.tsx`),
producing `docs/screenshots/panels/notifications-{sm,md,lg}-settings.png`
alongside the normal content shots — with the identical below-the-fold
`-full` variant treatment (`captureFullVariantIfClipped`, shared with the
main per-panel loop), since the settings view reliably clips at every
preset size once `enchantedDrop`'s editor is showing.

**PRD §10 open item, verified.** "Verify the `save-settings` main handler is
cheap/idempotent for unchanged hotkey/title fields before adopting
apply-on-change saves" — confirmed already true, no code change needed:
`main/index.ts`'s `save-settings` handler only calls
`globalShortcut.unregister`/`registerHotkey` when `hotkeyChanged` is true,
and window-title attach (`OverlayController.attachByTitle`) is only ever
called once at startup, outside this handler entirely — a title change just
sets the `needsRestart` flag in the response for `ConfigWindow` to prompt
on, it never re-attaches inline.

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
  // `settings` (the full live NotificationsSettings) is only needed if your
  // rule wants to consult another kind's resolved settings, the way
  // whiteBag/orangeBag do (see "Loot-bag spoiler avoidance" above) - most
  // rules ignore the third parameter entirely.
  match: (event, params, settings) => {
    if (event.type !== 'loot-drop') return null
    // ... your predicate ...
    return { title: '...', body: '...', icon: event.itemType }
  }
}
export const CATALOG: readonly AlertKind[] = [whiteBag, orangeBag, enchantedDrop, myNewRule]
```

No change is needed to `dispatcher.ts`, `store.ts`, or `AlertEngine.ts` — the
extensibility test above proves this end-to-end. Nor is any change needed to
the settings UI (`AlertSettings.tsx`) — `settingsRows.ts`'s `buildRuleRows`
generates that new entry's row from `CATALOG` directly, proved the same way
by `test/alerts-settingsRows.test.ts`'s synthetic-entry test. A rule needing
typed params (like `enchantedDrop`) defines its own params interface in
`catalog.ts` and casts `rawParams` to it inside `match`, same as
`enchantedDrop` does. A rule with a params **editor UI** additionally
registers one in `alerts/paramsEditors.ts` (issue #221 — see "Settings gear"
above).

Only a genuinely **new event kind** (not just a new rule over an existing
one) requires touching `types.ts` (`GameEvent`) and `AlertEngine.ts` (a new
detector, or an existing tracker's `onEntry`-style hook) — see the PRD §2
distinction between "detectors" and "catalog entries".
