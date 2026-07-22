# Dev mode

Issues #265 and #266. Two layers, both machine-local, that separate the
maintainer/soak-PC experience from the ordinary-user experience:

- **The unlock** (`OverlaySettings.devMode`, issue #265) — a hand-edited
  settings.json field. Off/absent = the Settings window has no Developer
  section at all, and the updater never offers an alpha release, full stop.
- **The toggle** (`OverlaySettings.devModeToggle`, issue #266) — a normal,
  UI-editable, persisted setting that only has any effect once the unlock is
  on. It controls whether the unlock's debug surfaces (Console panel, Status
  panel diagnostics, drag-perf) are *currently* active, so a maintainer can
  flip them off without hand-editing settings.json and without losing the
  unlock itself. It deliberately does **not** reach the updater's channel
  filtering — see "Updater channel" below.

Both are **curation, not security** — this repo and its releases are public,
and that's accepted; the goal is only that ordinary users never stumble into
debug UI or get pushed a soak (`-alpha`) build, and that a maintainer can
quiet debug surfaces at runtime without risking the soak PC silently falling
off the alpha channel.

## The unlock

- **Field:** `devMode: boolean` on `OverlaySettings` (`overlay/src/shared/settings.ts`).
  `DEFAULT_SETTINGS.devMode = false`.
- **Storage:** the existing settings store — `app.getPath('userData')/settings.json`
  (`overlay/src/main/settings.ts`). `loadSettings()` merges the file over
  `DEFAULT_SETTINGS`, so an absent key resolves to `false` — **absent = off**.
- **No way to set or clear it from the UI**, by design (issue #266 keeps this
  out of scope). `ConfigWindow.tsx` never writes this field; a maintainer (or
  the Windows soak PC) turns it on by hand-editing `settings.json` and adding
  `"devMode": true`, then restarting the app. `ConfigWindow` *reads* it
  (to decide whether to render the Developer section — see below) and still
  round-trips it correctly when the user changes *other* settings and clicks
  Save — it loads the full `OverlaySettings` object via `getSettings()` into
  local state and sends the whole object back on save, so a hand-set
  `devMode: true` isn't clobbered by an unrelated save.
- **Takes effect on restart** for the update-channel behavior (`main/index.ts`
  reads `settings.devMode` once per `checkForUpdate`/`startUpdatePolling`
  call, from the module-scope `settings` loaded at startup); the
  Developer-section's *visibility* in the Settings window reacts live (it's
  computed from React state loaded via `getSettings()`/`onSettingsChanged()`
  each time that window mounts/updates), but there is no UI path that flips
  the unlock itself — only a restart after a hand-edit does.

## The toggle

- **Field:** `devModeToggle: boolean` on `OverlaySettings`.
  `DEFAULT_SETTINGS.devModeToggle = true` — a freshly-unlocked maintainer
  sees every debug surface immediately, without an extra step; the toggle is
  there to turn things *off*, not to require turning them on.
- **UI:** the Settings window (`ConfigWindow.tsx`) renders a "Developer"
  section with a single "Dev mode" checkbox bound to this field —
  but only while `settings.devMode` (the unlock) is true; the section and the
  checkbox are entirely absent otherwise, and the field is inert if somehow
  present in the store without the unlock (see `isDevModeActive` below).
  Saved the same way as every other `ConfigWindow` field — full
  `OverlaySettings` object round-tripped through `saveSettings`, applied live
  via the existing `IPC.settingsChanged` push (`main/index.ts`'s
  `saveSettings` handler), same "applies on Save, no restart needed" pattern
  as `recordSessionToDisk`/the textile sliders.
- **What reads it:** nothing reads `devModeToggle` directly except
  `isDevModeActive()` (`shared/settings.ts`) — every gated surface calls that
  instead of checking `devMode` alone:
  ```ts
  export function isDevModeActive(settings: Pick<OverlaySettings, 'devMode' | 'devModeToggle'>): boolean {
    return settings.devMode && settings.devModeToggle
  }
  ```
  `StatusPanel.tsx` and `PanelCanvas.tsx` each call this from their existing
  independent `getSettings()`/`onSettingsChanged()` subscriptions (see
  "No new IPC surface" below) instead of reading `settings.devMode` raw, and
  pass the result down as the same `devMode`-named boolean prop/local state
  `PanelFrame`/`dragPerf.ts` already expected — no signature changes needed
  in those.
- **No new IPC surface.** The renderer reads both fields through the
  settings IPC/preload path that already exists (`getSettings()`/
  `onSettingsChanged()`), the same pair `StatusPanel.tsx` already used for
  `toggleHotkey` and `SpriteProvider.tsx` for the textile settings. There's
  no dedicated `useDevMode()` context — `PanelCanvas.tsx` and `StatusPanel.tsx`
  each subscribe independently, matching how every other settings-slice
  consumer in the renderer already reads `window.overlay.getSettings()`
  directly rather than through a shared context.

## What it gates

### Debug panels & Status panel diagnostics

`PanelSpec.debugOnly` (`overlay/src/renderer/src/panels/registry.ts`) marks a
panel type as dev-mode-only. Currently just `console` (the Console/packet
log panel). Two places check `isDevModeActive(settings)` (never `devMode`
alone, since issue #266 — the toggle must be able to hide these too):

- **`StatusPanel.tsx`'s `togglablePanels(devModeActive)`** — the panel picker
  (the Status panel's "Panels" toggle-chip list) excludes any `debugOnly`
  panel while dev mode isn't active, so it's not addable.
- **`PanelCanvas.tsx`'s render guard** —
  `if (!spec || panel.hidden || (spec.debugOnly && !devModeActive)) return null`
  (the local state is still named `devMode` in both components' source for
  brevity, but it's assigned from `isDevModeActive(settings)`, not
  `settings.devMode`). A `debugOnly` panel instance that's already present in
  the layout (a saved `panels.json`, or `defaultLayout()`, which still lists
  `console`) simply doesn't render while dev mode isn't active — its
  `PanelInstance` (anchor, size, pin, hidden) is left completely alone.
  Dev mode becoming active again (unlock on AND toggle on) makes it reappear
  exactly where it was, the same "survives" guarantee an ordinary closed
  (`hidden: true`) panel already gets — see `overlay-renderer.md` §2
  "Closeable panels & the Status panel's toggle list" for that mechanism;
  `debugOnly` is a third gate layered on top of `hidden`/`ephemeral`.

Within the Status panel itself (not a separate panel type, so not gated by
`debugOnly`), two elements are gated directly on the same `isDevModeActive`
result in `StatusPanel.tsx`:

- The **chat probe** button (local-only capture of chat/party packets for
  wire-shape diagnosis, issue #222) — hidden entirely; the rest of the action
  row (Report bug, Capture now, update check) is unaffected and works
  normally for every user.
- The **`lg`-size "last packet" line** (`last: {direction} {type}`) — a raw
  wire-format debug readout.

Everything else in the Status panel (connection dot, hotkey hint, packet
count, JS heap MB, version, the panel toggle list itself, update-check UI)
renders the same regardless of dev mode.

### Drag-perf instrumentation

`dragPerf.ts`'s `startDragPerf(devMode)` returns the no-op session outright
when its `devMode` argument is falsy, regardless of the module's own
`DRAG_PERF_DEBUG` source constant. That argument flows `PanelCanvas` (calls
`isDevModeActive(settings)` once) → `PanelFrame` (a `devMode` prop) →
`startDragPerf`. With dev mode inactive this is unconditionally inert — no
rAF sampling loop even starts. With dev mode active, behavior is unchanged
from before issue #266: `DRAG_PERF_DEBUG` still has to be hand-flipped to
`true` in source and rebuilt for it to actually log a `[drag-perf]` summary
to the Console panel; dev mode alone doesn't turn on logging, it only
removes the possibility of it running for an ordinary user.

### Updater channel

`overlay/src/main/updater.ts`'s `checkForUpdate(devMode)` delegates release
selection to the pure `pickRelease(releases, currentVersion, devMode)` — and
every call site (`main/index.ts`'s `startUpdatePolling`, `IPC.checkForUpdate`,
`IPC.downloadUpdate`) passes `settings.devMode` **directly**, never
`isDevModeActive(settings)`. This is deliberate (issue #266's "deliberate
exception"): the toggle must never be able to drop the soak PC off the alpha
channel just because a maintainer turned debug UI off there.

- Drafts are always excluded.
- With `devMode` false, any release tag matching `isAlphaTag` (an `-alpha`
  prerelease component, e.g. `v0.9.30-alpha`) is excluded *before* the
  numeric-version comparison — so an alpha is never offered even when it's
  the numerically newest release. `-beta` and unsuffixed tags are unaffected
  either way — those channels are offered to every user, dev mode or not.
  Legacy `overlay-test-vX.Y.Z` tags (pre-dating the channel scheme entirely)
  are deliberately treated as non-alpha, matching how `parseTagVersion`
  already treats them as first-class for ordering.
- With `devMode` true, alphas are included in selection exactly as before
  issue #265, **regardless of `devModeToggle`** — this is what keeps the
  Windows soak PC's app auto-updating to fresh alphas during a soak even if
  its Developer-section toggle is off.

`isAlphaTag`/`pickRelease` are exported and unit-tested directly
(`overlay/test/updater-channel.test.ts`) rather than through the network-
calling `checkForUpdate`, which needs Electron's `net` — see that file's
`vi.mock('electron', …)` stub (same pattern as `test/spritePack.test.ts`).

## The screenshot harness

`npm run shots` (`docs/overlay-harness.md`) must still render every gated
panel/diagnostic so the committed gallery under `docs/screenshots/panels/`
stays complete — there's no real maintainer-vs-user distinction inside
headless Chromium, and no Developer-section checkbox to click in a headless
run either. `renderer/src/harness/shim.ts`'s `installHarness()` forces both
`devMode: true` and `devModeToggle: true` unconditionally on the
`OverlayApi` shim's settings (persisted values always overridden), so both
the full `<App/>` harness canvas and the single-panel `?panel=<type>` mount
(`PanelMount.tsx`, which reads settings through the same
`window.overlay.getSettings()` a real panel like `StatusPanel` calls) see
dev mode fully active. `ConfigWindow.tsx` itself (the Settings window,
including the new Developer section) is not part of the harness/screenshot
pipeline at all — `harness/mount.tsx`'s `bootstrapHarness(isConfigWindow)`
returns early for it — so there is no committed shot of the Developer
section; it's verified by inspection/typecheck instead.

## Rollout

Not agent work, but recorded here since it's the whole point of the flags:
after this ships, a maintainer hand-adds `"devMode": true` to `settings.json`
on the dev Mac and the Windows soak PC before the next alpha soak — otherwise
those machines stop seeing `-alpha` releases the moment a build with this
flag reaches them, and the soak PC would silently stall on its last-installed
alpha. `devModeToggle` needs no rollout step — it defaults to `true`, so
those same machines see every debug surface immediately once unlocked, same
as before issue #266 existed.
