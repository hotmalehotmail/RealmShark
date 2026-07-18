# Notification system ("alerts") — engine core

Design doc: [prd-notifications.md](prd-notifications.md). This doc covers the
**shipped implementation** of issue #218 — the framework-agnostic core (event
detection, rule catalog, dispatcher, fired-alert store, settings schema). It
ships **no visible UI** (no banner, no sound, no panel, no settings form) —
those are issues #219-#221 in the PRD's §11 implementation plan, all building
on the contract this doc describes. Naming: the subsystem is `alerts`
internally, "Notifications" user-facing (PRD §1).

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
                                  (issue #219, unused           (issue #219,        (this issue's entire
                                     by this issue)                unused)          externally-visible output)
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

`types.ts`, `catalog.ts`, `dispatcher.ts`, `store.ts`, and `AlertEngine.ts`
import **nothing** from React or any component/UI module — every test for
them (`overlay/test/alerts-*.test.ts`) runs in vitest's plain `node`
environment, no DOM. `useAlertEngine.ts` is the one `.ts` file that touches
React (`useState`/`useEffect`), and it is intentionally thin: construct the
engine once, wire IPC, return the instance. A future banner UI (issue #219)
touches `AlertToastHost.tsx` alone; a future history panel (issue #220) reads
only `engine.store`'s subscribe API — neither ever reaches into `AlertEngine`
internals or the dispatcher.

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

## Settings (`shared/settings.ts`)

```ts
interface NotificationsSettings {
  enabled: boolean                              // master switch
  volume: number                                 // 0..1; unused until issue #219 (sound)
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
