# Dev mode

Issue #265. A single machine-local flag, `OverlaySettings.devMode`, that
separates the maintainer/soak-PC experience from the ordinary-user
experience. It is **curation, not security** — this repo and its releases
are public, and that's accepted; the goal is only that ordinary users never
stumble into debug UI or get pushed a soak (`-alpha`) build.

## The flag

- **Field:** `devMode: boolean` on `OverlaySettings` (`overlay/src/shared/settings.ts`).
  `DEFAULT_SETTINGS.devMode = false`.
- **Storage:** the existing settings store — `app.getPath('userData')/settings.json`
  (`overlay/src/main/settings.ts`). `loadSettings()` merges the file over
  `DEFAULT_SETTINGS`, so an absent key resolves to `false` — **absent = off**.
- **No settings-window UI.** `ConfigWindow.tsx` never reads or writes this
  field; a maintainer (or the Windows soak PC) turns it on by hand-editing
  `settings.json` and adding `"devMode": true`, then restarting the app.
  `ConfigWindow` still round-trips the field correctly when the user changes
  *other* settings and clicks Save — it loads the full `OverlaySettings`
  object via `getSettings()` into local state and sends the whole object back
  on save, so a hand-set `devMode: true` isn't clobbered by an unrelated save.
- **No new IPC surface.** The renderer reads it through the settings IPC/
  preload path that already exists (`getSettings()`/`onSettingsChanged()`),
  the same pair `StatusPanel.tsx` already used for `toggleHotkey` and
  `SpriteProvider.tsx` for the textile settings. There's no dedicated
  `useDevMode()` context — `PanelCanvas.tsx` and `StatusPanel.tsx` each
  subscribe independently, matching how every other settings-slice consumer
  in the renderer already reads `window.overlay.getSettings()` directly
  rather than through a shared context.
- **Takes effect on restart** for the update-channel behavior (`main/index.ts`
  reads `settings.devMode` once per `checkForUpdate`/`startUpdatePolling`
  call, from the module-scope `settings` loaded at startup); the renderer-side
  gates (panel visibility, diagnostics) react live to `onSettingsChanged` like
  any other setting, but there is no UI path that fires it — only a restart
  after a hand-edit does.

## What it gates

### Debug panels & Status panel diagnostics

`PanelSpec.debugOnly` (`overlay/src/renderer/src/panels/registry.ts`) marks a
panel type as dev-mode-only. Currently just `console` (the Console/packet
log panel). Two places check it:

- **`StatusPanel.tsx`'s `togglablePanels(devMode)`** — the panel picker (the
  Status panel's "Panels" toggle-chip list) excludes any `debugOnly` panel
  while `devMode` is off, so it's not addable.
- **`PanelCanvas.tsx`'s render guard** —
  `if (!spec || panel.hidden || (spec.debugOnly && !devMode)) return null`.
  A `debugOnly` panel instance that's already present in the layout (a saved
  `panels.json`, or `defaultLayout()`, which still lists `console`) simply
  doesn't render while dev mode is off — its `PanelInstance` (anchor, size,
  pin, hidden) is left completely alone. Flipping dev mode on makes it
  reappear exactly where it was, the same "survives" guarantee an ordinary
  closed (`hidden: true`) panel already gets — see `overlay-renderer.md` §2
  "Closeable panels & the Status panel's toggle list" for that mechanism;
  `debugOnly` is a third gate layered on top of `hidden`/`ephemeral`.

Within the Status panel itself (not a separate panel type, so not gated by
`debugOnly`), two elements are gated directly on `devMode` in
`StatusPanel.tsx`:

- The **chat probe** button (local-only capture of chat/party packets for
  wire-shape diagnosis, issue #222) — hidden entirely; the rest of the action
  row (Report bug, Capture now, update check) is unaffected and works
  normally for every user.
- The **`lg`-size "last packet" line** (`last: {direction} {type}`) — a raw
  wire-format debug readout.

Everything else in the Status panel (connection dot, hotkey hint, packet
count, JS heap MB, version, the panel toggle list itself, update-check UI)
renders the same regardless of `devMode`.

### Drag-perf instrumentation

`dragPerf.ts`'s `startDragPerf(devMode)` returns the no-op session outright
when `devMode` is false, regardless of the module's own `DRAG_PERF_DEBUG`
source constant. `devMode` flows `PanelCanvas` (fetches it once) →
`PanelFrame` (a `devMode` prop) → `startDragPerf`. With dev mode off this is
unconditionally inert — no rAF sampling loop even starts. With dev mode on,
behavior is unchanged from before this issue: `DRAG_PERF_DEBUG` still has to
be hand-flipped to `true` in source and rebuilt for it to actually log a
`[drag-perf]` summary to the Console panel; dev mode alone doesn't turn on
logging, it only removes the possibility of it running for an ordinary user.

### Updater channel

`overlay/src/main/updater.ts`'s `checkForUpdate(devMode)` delegates release
selection to the pure `pickRelease(releases, currentVersion, devMode)`:

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
  this issue — this is what keeps the Windows soak PC's app auto-updating to
  fresh alphas during a soak (`startUpdatePolling`, `IPC.checkForUpdate`,
  `IPC.downloadUpdate` in `main/index.ts` all pass `settings.devMode` through).

`isAlphaTag`/`pickRelease` are exported and unit-tested directly
(`overlay/test/updater-channel.test.ts`) rather than through the network-
calling `checkForUpdate`, which needs Electron's `net` — see that file's
`vi.mock('electron', …)` stub (same pattern as `test/spritePack.test.ts`).

## The screenshot harness

`npm run shots` (`docs/overlay-harness.md`) must still render every gated
panel/diagnostic so the committed gallery under `docs/screenshots/panels/`
stays complete — there's no real maintainer-vs-user distinction inside
headless Chromium. `renderer/src/harness/shim.ts`'s `installHarness()` forces
`devMode: true` unconditionally on the `OverlayApi` shim's settings
(`{ ...DEFAULT_SETTINGS, ...persisted, devMode: true }`, persisted value
always overridden), so both the full `<App/>` harness canvas and the
single-panel `?panel=<type>` mount (`PanelMount.tsx`, which reads settings
through the same `window.overlay.getSettings()` a real panel like
`StatusPanel` calls) see dev mode on.

## Rollout

Not agent work, but recorded here since it's the whole point of the flag:
after this ships, a maintainer hand-adds `"devMode": true` to `settings.json`
on the dev Mac and the Windows soak PC before the next alpha soak — otherwise
those machines stop seeing `-alpha` releases the moment a build with this
flag reaches them, and the soak PC would silently stall on its last-installed
alpha.
