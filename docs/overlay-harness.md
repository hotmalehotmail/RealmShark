# Overlay renderer harness & screenshot pipeline

Implements PRD Phase 2 (`docs/prd-agent-observability.md` §5): a way to host
the overlay's React renderer in plain headless Chromium, with **no Electron
process behind it**, plus a deterministic screenshot pipeline so an agent (or
a human) can *see* every panel render before a PR opens. Read this before
touching anything under `overlay/src/renderer/src/harness/`, `overlay/e2e/`,
or `overlay/vite.harness.config.ts`.

## Why this is possible at all

The renderer is plain React + Tailwind. Its **only** dependency on Electron is
`window.overlay`, an `OverlayApi` (`overlay/src/shared/overlayApi.ts`, ~25
methods) the preload script publishes via `contextBridge`. Window attachment
(`electron-overlay-window`) lives entirely in the main process and is
irrelevant to "does the panel render correctly." Anything that provides
`window.overlay` can host the renderer - including an ordinary browser page.

## Components

```
overlay/
  src/renderer/src/harness/
    shim.ts          # implements OverlayApi without Electron
    wsSource.ts       # live-fake mode: WS client straight to the bridge
    fixtureSource.ts  # fixture mode: loads + rebases + replays a capture/fixture
    mount.tsx          # installs the shim; handles the ?panel=&size= mount mode
    PanelMount.tsx     # renders one registered panel at its preset size
    global.d.ts         # ambient types: window.__harnessFixtureReady, VITE_HARNESS
  vite.harness.config.ts   # plain-vite config reusing the renderer's plugins/alias
  e2e/
    shots.spec.ts    # Playwright: mount each panel × size, screenshot
    playwright.config.ts
  test/fixtures/
    gallery.json.gz      # standard fixture populating every panel (for the shots)
    spritePack.json      # a small synthetic atlas (fixture-mode sprites)
docs/screenshots/panels/ # committed gallery: <type>-<size>.png, overwritten in place
                          # (+ <type>-<size>-full.png where content clips - see below)
```

### The shim (`harness/shim.ts`)

`installHarness()` builds an `OverlayApi` object and assigns it to
`window.overlay`:

- `getSettings`/`getPanelLayout`/`savePanelLayout`/`saveSettings` are backed by
  `localStorage` (keys prefixed `realmshark-harness:`), falling back to
  `DEFAULT_SETTINGS`/`null` exactly like the main process's first-run
  defaults.
- `getBridgeStatus` resolves `'connected'` immediately; `onAttachSuccess` and
  `onInteractiveChange(true)` fire once, deferred by a short `setTimeout` so
  `App`'s mount-time `useEffect` subscribers are registered first - the
  browser-side equivalent of the `toggleInteractive` recipe in the root
  `CLAUDE.md`'s "Local testing" section, and of `main/index.ts`'s own
  non-`supportsAttach` fallback (`setTimeout(() => …attachSuccess, 1000)`).
- The updater surface (`checkForUpdate`/`downloadUpdate`/`getUpdateStatus`)
  and `relaunch`/`reportBug` are no-ops.
- `onPacketBatch`/`onSpritePack` are wired to whichever **data source** the
  URL selects (below). `setPacketBatchSuspended` is implemented for real (the
  same buffer-and-replay semantics as the preload's, since `PanelFrame`'s drag
  handlers call it unconditionally on `window.overlay`).
- A few representative `console.*` lines are emitted right after install
  (`logHarnessBanner`), so the Console panel - fed only by real `console.*`
  calls, never the packet stream - isn't an empty "no logs yet" in every
  screenshot.

`OverlayApi` is defined in `overlay/src/shared/overlayApi.ts` as an explicit
interface (not `typeof overlayApi` inferred from the preload's object
literal) *specifically* so this shim can implement it without importing
`preload/index.ts`, which pulls in `electron`'s `contextBridge`/`ipcRenderer`
and does not bundle for a plain browser page.

### Data source 1 — live-fake (`harness/wsSource.ts`)

The default (no `?fixture=` param): a page-side `WebSocket` straight to
`ws://127.0.0.1:47474`, i.e. `gradle runBridge -Pargs="--fake"`. Mirrors
`overlay/src/main/bridgeClient.ts` - hello-frame validation
(`{"type":"hello","service":"realmshark-bridge"}`), `{"batch":[...]}` message
parsing, the `spritePack` control message, and requesting the sprite pack
(`{"type":"spritePackRequest","haveVersion":null}`) once verified - using the
browser's native `WebSocket` instead of the `ws` npm package, since this code
runs in Chromium, not Node. Real Java, real `FakePacketSource`, zero
Electron; see `CLAUDE.md`'s "Local testing" section for what
`FakePacketSource` simulates.

### Data source 2 — fixture (`harness/fixtureSource.ts`)

`?fixture=<name>` loads `overlay/test/fixtures/<name>.json` or `.json.gz`
(bare `PacketEnvelope[]` or a full capture object - the exact same flexible
shape `overlay/test/replay.ts`'s `loadCapture()` accepts for the vitest
suite, reimplemented here for the browser since that module uses Node's
`fs`/`zlib`). Fixtures are served by `vite.harness.config.ts`'s `publicDir`
pointed at `test/fixtures/`, so `fetch('/gallery.json.gz')` just works with no
custom server code.

**Timestamp rebasing** is the load-bearing step: every envelope's `time` is
shifted by a constant offset so the *last* envelope lands at `Date.now()` at
load time, before replay. `DpsTracker.ts`/`LootTracker.ts` compare envelope
timestamps against `Date.now()` for their rolling-window/carry-forward logic
(same reason `overlay/test/replay.ts` anchors vitest's fake clock - see
`docs/overlay-testing.md`'s D3 note); an unrebased old capture would render
as "everything already expired." Delivery is then near-instant by default
(chunked across a handful of `requestAnimationFrame`s, so React isn't asked to
process a thousand-envelope batch synchronously) or, with `?paced`, spaced by
the fixture's own original inter-envelope deltas (capped) for watching a
capture play out like a real session. Either way,
`window.__harnessFixtureReady` flips `true` once every envelope has been
delivered - the deterministic "ready" signal `e2e/shots.spec.ts` waits on
instead of a fixed sleep.

Sprites always come from the separate `test/fixtures/spritePack.json` fixture
(fetched unconditionally, independent of which packet fixture is loaded) - a
small hand-generated synthetic atlas (see below), not a live bridge's real
extracted assets.

### Bootstrap (`main.tsx` + `harness/mount.tsx`)

`main.tsx`'s `bootstrap()` dynamically imports `harness/mount.tsx` **only
when** `window.overlay` is `undefined` **and** `import.meta.env.VITE_HARNESS`
is set:

```ts
if (typeof window.overlay === 'undefined' && import.meta.env.VITE_HARNESS) {
  const { bootstrapHarness } = await import('./harness/mount')
  if (bootstrapHarness(isConfigWindow)) return
}
```

`VITE_HARNESS` is never defined for the electron-vite (production) build, so
Vite statically inlines that whole `import.meta.env` property access as
`undefined` and Rollup dead-code-eliminates the branch - and everything
`harness/` transitively imports - out of the packaged bundle entirely. See
"Keeping the harness out of production" below for how that's verified, not
just asserted.

`bootstrapHarness` installs the shim, then checks for the **mount mode**:

- **Full canvas** (default): returns `false`; `main.tsx` renders `<App/>`
  exactly as production does, panel canvas and all.
- **Single panel** — `?panel=<type>&size=<sm|md|lg>`: renders
  `harness/PanelMount.tsx` directly into `#root` instead, and returns `true`
  so `main.tsx` skips its own render. `PanelMount` mounts exactly one
  `PANEL_REGISTRY[type]` entry at its preset pixel dimensions, wrapped in the
  same providers (`SpriteProvider`/`EntityRegistryProvider`/`ItemInfoProvider`/
  `AlertStoreContext`) and the same chrome (title bar) `PanelFrame` renders,
  minus drag/pin/resize affordances - irrelevant to a single frozen shot.
  This is the unit `npm run shots` screenshots. For `type === 'notifications'`
  (issue #220) specifically, `PanelMount` seeds the provided `FiredAlertStore`
  with `harness/alertGallerySeed.ts`'s `seedGallery` - the same four
  representative alerts the toast gallery below uses - so the shot shows
  real content instead of the empty state; every other panel type gets an
  unseeded, harmless store.
- **Alert toast gallery** — `?toastGallery=1` (issue #219): renders
  `harness/AlertToastGalleryMount.tsx` instead, for the one UI surface that
  isn't a `PANEL_REGISTRY` entry (`AlertToastHost` is an App-level singleton,
  not a draggable/resizable panel). It seeds a `FiredAlertStore` directly
  with four representative fired alerts rather than replaying a packet
  fixture - see `docs/notifications.md`'s "Delivery" section for why the
  seeding happens in a `useEffect` timed after `AlertToastHost`'s own mount
  (and why it's undone on cleanup). Screenshotted to the same
  `docs/screenshots/panels/` gallery as
  `alertToastHost-gallery.png` by a dedicated `e2e/shots.spec.ts` test
  outside the per-panel loop below.

## The synthetic `spritePack.json` fixture

Real sprites require a real game install (`SpritePackService` on the bridge
side never becomes `ready` without one - confirmed empirically: `--fake` mode
broadcasts `{ready: false}`), and the PRD's non-goals explicitly rule out
committing real extracted game assets. `test/fixtures/spritePack.json` is
instead a **small, hand-generated** atlas: one 128×80 RGBA PNG (built with a
from-scratch PNG encoder - `zlib.deflateSync` + hand-assembled
IHDR/IDAT/IEND chunks, no image library dependency - see the generation notes
in this file's git history if you need to regenerate it) containing a 16×16
colored, bordered cell per objectType referenced anywhere in `gallery.json`
(every roster member's equipped items, the two fake enemies, the two boss
phases, the loot-bag icons/items, the local player's skin and clothing/
accessory dyes - 37 objectTypes in total). Only the `table` field is
populated (no `maskTable`/`dyeTable`/`animTable`/`animDyeTable`/
`dungeonIcons`) - dyed/animated compositing falls back to the plain sprite,
which is fine here: the goal is "every panel shows a real cropped sprite
instead of a placeholder color chip," not full dye fidelity. A side effect
worth knowing: because nothing in this fixture is animated, `npm run shots`
has nothing JS-driven to freeze for determinism (see below) - the fixture's
simplicity was a deliberate choice, not an oversight.

The fixture also carries a `uiSprites` section (issue #205/#206) - five tiny
hand-generated PNGs (a 16×16 gem per rarity tier, an 8×8 sparkle for
`shiny_item_icon`), same "no real game art" rule as the base atlas above, so
`npm run shots` exercises the real pip/shiny rendering path in
`sprites/Sprite.tsx` instead of only its CSS-ring/SVG-badge fallback. A
bridge that hasn't extracted `uiSprites` yet (predates #205, or has no game
assets) still exercises the fallback path live, just not in this fixture.

## The `gallery.json` fixture

Not hand-authored: recorded by running the real bridge
(`gradle runBridge -Pargs="--fake"`) and capturing ~70 real seconds of its
WebSocket broadcast (after trimming a longer recording) with a throwaway
Node/`WebSocket` script, then committing the result gzipped. This guarantees
wire-format fidelity for free - every envelope is exactly what a real
(fake-mode) bridge produces, not a guess at the shape. It captures several
`FakePacketSource` map cycles: the full 4-player named roster with equipment
and enchants, a two-phase boss encounter (exercising `DpsTracker`'s sticky
quest-objective lock), the transient 5th player joining/leaving, the
equip/unequip round-trip, and multiple white/orange/boosted-white loot-bag
drops - see the root `CLAUDE.md`'s "Local testing" section for the full list
of what `FakePacketSource` simulates. The four bridge-synthesized "table"
envelope types (`lootBagTypes`/`itemInfo`/`enchantNames`/`objectNames`) are
kept in full regardless of the time window, since the bridge stamps them with
a fixed "table became ready" timestamp rather than a per-broadcast one, so a
naive time-window trim would silently drop them all.

## The screenshot script (`npm run shots`)

`e2e/shots.spec.ts` is a Playwright test file, one test per `(panel type,
size)` pair - enumerated from `PANEL_REGISTRY` (`panels/registry.ts`)
directly, never hardcoded, so a new panel type or size preset needs no change
here. Each test:

1. Navigates to `/?panel=<type>&size=<size>&fixture=gallery`.
2. Waits for `window.__harnessFixtureReady === true`.
3. Screenshots the `[data-panel-frame]` element to
   `docs/screenshots/panels/<type>-<size>.png` - a **stable path, overwritten
   in place** (PRD D7), so a before/after diff across two refs is just two
   `git show`s of the same path, and the file doubles as a living gallery.

`e2e/playwright.config.ts` drives it: `webServer` starts
`vite --config vite.harness.config.ts` itself, so `npm run shots` is a single
command with no manual dev-server step. `npm run dev` (electron-vite) is
completely untouched - the harness's plain-vite config is a separate file
that happens to reuse the same `root`/`index.html`/`main.tsx`/`@renderer`
alias/Tailwind plugin.

### The `-full` variant: below-the-fold blind spot

A panel's content wrapper (`data-panel-content` on the scrollable div in
`PanelMount.tsx`) uses `overflow-auto` at its preset size, so any content
below the fold is real but invisible in the preset shot - discovered on PR
#177, where a new Status-panel button produced zero pixel diff in the
gallery because it landed below the fold. The preset shot is still
legitimate evidence (it's exactly what the user sees at that preset size),
but it's silently *incomplete* whenever content clips.

After taking the normal `<type>-<size>.png` shot, each test measures the
content wrapper's `scrollHeight` against its `clientHeight`. When
`scrollHeight` exceeds `clientHeight` (clipping), the test re-renders the
same mount with the wrapper expanded to its natural content height - capped
at `MAX_FULL_HEIGHT_PX` (2000px, `e2e/shots.spec.ts`) so unbounded content
like a long console log can't blow the shot up arbitrarily - and saves a
*second* screenshot to `docs/screenshots/panels/<type>-<size>-full.png`.

- **The existence of a `-full` file is itself the signal**: "this panel
  hides content at this preset size." There's no separate manifest or flag -
  a reviewer or the review judge just checks whether `<type>-<size>-full.png`
  is present.
- **Emitted only when clipping is real.** A combo whose content fits at its
  preset size never gets a `-full` file.
- **Orphan pruning.** Every `(panel type, size)` combo is re-checked on every
  `npm run shots` run; if a combo that previously clipped no longer does
  (e.g. a layout fix), its stale `-full` file is deleted in the same run - a
  `-full` file can never outlive the clipping it documents.
- **The preset shot is untouched.** The `<type>-<size>.png` screenshot is
  always taken first, before anything expands the DOM, so this entirely
  additive step never changes the preset gallery.
- **Determinism** holds the same way as the preset shots (frozen clock/heap,
  same fixture) - re-running `npm run shots` reproduces the same `-full`
  files byte-for-byte, and produces the same set of `-full` files every time
  for a given codebase.

No workflow, review-prompt, or gallery-consumer change is needed for this:
the soak gallery diffs any PNG under `docs/screenshots/panels/`, the review
judge reads the whole directory, and "changed PNGs" in the agent contract
already covers new files.

### Determinism

Two things read real, run-to-run-varying browser state that has nothing to do
with which fixture is loaded: the Console panel timestamps every line with
`Date.now()` at log time, and the Status panel reads live heap usage
(`performance.memory.usedJSHeapSize`). Neither can be pinned in *production*
code (this issue's shipped-behavior delta is limited to the dev-flag guard in
`main.tsx` - no panel logic changes), so `shots.spec.ts` freezes both
test-side, via `page.addInitScript` before the app's first script runs:
`Date.now` is overridden to a fixed constant (not the `Date` constructor -
every call site that matters, including `fixtureSource.ts`'s own rebase math,
calls `Date.now()`, never `new Date()` for "now"), and
`performance.memory.usedJSHeapSize` is redefined to a fixed value. Combined
with the CSS animation/transition reset also applied per test (defensive -
the sprite fixture has nothing animated to begin with, see above), re-running
`npm run shots` with no code change reproduces byte-identical PNGs - verified
by running it twice and diffing all 21 files.

`launchOptions.executablePath` points at this repo's sandbox-pinned Chromium
(`/opt/pw-browsers/chromium`, overridable via `PLAYWRIGHT_CHROMIUM_PATH` for
local Windows/Mac dev) instead of Playwright's own version-matched download -
see the root `CLAUDE.md`'s "Pre-installed browser" section. Only
sandbox-generated shots are committed (PRD §5.5/§10 risk: cross-platform
rendering noise); a locally-generated shot from a developer's own machine is
for eyeballing, not for the committed gallery.

### CSP: why the harness needs its own `transformIndexHtml`

The shared `overlay/src/renderer/index.html` has a CSP meta tag with no
`connect-src`, so it falls back to `default-src 'self'` - fine for the
packaged app (the bridge's WebSocket client lives in the Electron *main*
process, never subject to a page's CSP), but it would block two things only
the harness needs: `wsSource.ts`'s page-side WebSocket to
`ws://127.0.0.1:47474`, and `SpriteProvider.tsx`'s `fetch()` of a sprite
atlas `data:` URL (`fetch()` is governed by `connect-src`, not `img-src`,
even when the target is a `data:` URL). `vite.harness.config.ts` loosens this
via a small `transformIndexHtml` plugin, at harness-serve time only -
`index.html` itself is never edited, so the production build's CSP is
byte-identical to before.

One more Vite-dev-server gotcha worth knowing if you touch
`fetchFixtureEnvelopes`: Vite's static file serving adds a real
`Content-Encoding: gzip` header when it serves a `.gz` file, which means the
*browser's network stack* transparently decompresses the body before JS ever
sees it - `fetch('/gallery.json.gz').then(r => r.text())` already returns
plain JSON. Manually piping the response through
`DecompressionStream('gzip')` on top of that throws (double-decompression).
`fetchFixtureEnvelopes` checks the response's `content-encoding` header and
only reaches for `DecompressionStream` when it's absent (e.g. a plain static
host serving `.gz` bytes verbatim with no transport-encoding header), so it
stays correct outside Vite's dev server too.

## Keeping the harness out of production

Two independent guards:

1. **The dev-flag gate itself** (`main.tsx`, above) - the actual mechanism.
2. **`scripts/check-no-harness.mjs`**, run as the last step of `npm run
   build` (`electron-vite build && node scripts/check-no-harness.mjs`):
   greps every built renderer `.js` file for a handful of string literals
   unique to harness modules (e.g. `realmshark-harness:`, `[harness/ws]`,
   `__harnessFixtureReady`). Minifiers preserve string literals verbatim even
   after stripping identifier names, so their absence is a reliable
   eliminated-or-not signal. Fails the build (non-zero exit) if any marker
   turns up in `out/renderer/`.

## Running it locally

```bash
cd overlay
npm run harness:dev        # plain-vite dev server on :5183, live-fake mode by default
# then visit, e.g.:
#   http://localhost:5183/                                   - full canvas, live-fake
#   http://localhost:5183/?fixture=gallery                    - full canvas, fixture mode
#   http://localhost:5183/?panel=dps&size=lg&fixture=gallery  - single panel, fixture mode
#   http://localhost:5183/?panel=dps&size=lg                  - single panel, live-fake

npm run shots               # regenerate docs/screenshots/panels/*.png
```

Live-fake mode needs `gradle runBridge -Pargs="--fake"` running separately
(see the root `CLAUDE.md`); fixture mode needs nothing but the harness dev
server itself.

## Out of scope here (later phases / human follow-ups)

- **`review.yml` screenshot check, `release.yml` soak-issue gallery,
  `ui:signoff` holds** - `.github/` changes are human/local-PR work (PRD §8);
  agents cannot touch `.github/`.
- **Visual-regression pixel diffing** - the gallery is for eyes (agent and
  human) to look at, not an automated pixel gate (PRD non-goal §3).
- **Capture-now button / session recorder** (PRD §7, a later issue).
- **Java-side capture replay** (PRD §6.5) - unrelated to this harness; see
  `docs/overlay-testing.md`'s "Out of scope" section.
