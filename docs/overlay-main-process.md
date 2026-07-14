# Overlay main process — window, bridge plumbing & the IPC contract

How the Electron **main process** runs the overlay: it creates the transparent
click-through HUD window and glues it onto the game window, supervises the
bundled Java **bridge** (spawning it if needed), streams the bridge's WebSocket
messages to the renderer, and persists settings / panel layout / the sprite-pack
cache. It also owns the tray, the global toggle hotkey, and the self-updater.
Everything the renderer is allowed to touch crosses a single `contextBridge`
surface defined in `preload/index.ts` over the channel names in `shared/ipc.ts`;
this doc is the reference for that boundary. Read `architecture.md` for the wire
shapes on the bridge socket, `bridge-server.md` for the Java side,
`overlay-renderer.md` for the UI that consumes these messages, and
`build-and-release.md` for the packaging/updater deep dive.

## Files covered

| File | Role |
| --- | --- |
| `overlay/src/main/index.ts` | App lifecycle; overlay `BrowserWindow`; attach/toggle/hotkey; registers every IPC handler. |
| `overlay/src/main/bridgeSupervisor.ts` | Probes `127.0.0.1:47474`, spawns/reaps the bundled `bridge.jar`. |
| `overlay/src/main/bridgeClient.ts` | WebSocket client to the bridge; validates hello, reconnects, forwards messages. |
| `overlay/src/main/settings.ts` | Load/persist `OverlaySettings` to `settings.json`. |
| `overlay/src/main/configWindow.ts` | The separate settings `BrowserWindow` (`#config` route). |
| `overlay/src/main/panelLayout.ts` | Load/persist the renderer's panel layout to `panels.json`. |
| `overlay/src/main/spritePack.ts` | Main-side sprite-pack cache + serve/push to renderer. |
| `overlay/src/main/consoleCapture.ts` | Patches `console.*` so main-process logs reach the renderer console panel. |
| `overlay/src/main/tray.ts` | Tray icon + context menu; shows bridge status. |
| `overlay/src/main/updater.ts` | GitHub-release self-updater (brief here; see `build-and-release.md`). |
| `overlay/src/preload/index.ts` (+ `index.d.ts`) | `window.overlay` contextBridge API. |
| `overlay/src/shared/ipc.ts` | `IPC` channel names + shared types (`SpritePack`, `PacketEnvelope`, …). |
| `overlay/src/shared/settings.ts` | `OverlaySettings` model + `DEFAULT_SETTINGS`. |
| `overlay/src/shared/panels.ts` | `PanelInstance` layout model (owned by the renderer). |
| `overlay/src/shared/capture.ts` | The "Report bug" capture ring's allowlist, per-type quotas, and eviction logic — imported by `index.ts` and by the test suite's allowlist tripwire. |

## The big picture

```
                      main process (index.ts)
  ┌──────────────────────────────────────────────────────────────┐
  │  bridgeSupervisor ──spawn──► bridge.jar (java)  :47474         │
  │        │ probe/reap                       ▲                    │
  │        ▼                                  │ ws://127.0.0.1     │
  │  bridgeClient ◄───────────────────────────┘                   │
  │    onStatus / onBatch / onSpritePack / onConnected            │
  │        │                                                       │
  │        ├─ spritePack.ts (disk cache) ──► IPC.spritePack        │
  │        ▼                                                       │
  │  overlayWindow.webContents.send(...) ─────────────────────────┼──►
  │                                                               │  renderer
  │  ipcMain.handle(...)  ◄─── invoke ────────────────────────────┼──◄
  └──────────────────────────────────────────────────────────────┘
        electron-overlay-window attaches overlayWindow onto the game
```

The main entry (`index.ts`) is the only place that holds a reference to
`overlayWindow`; every module pushes to the renderer through a callback it hands
`index.ts` (e.g. `initSpritePack(notify)`, `setMainLogSink(sink)`,
`startBridgeClient({ onBatch, … })`), and `index.ts` does the actual
`webContents.send`. Every `send` is guarded by
`overlayWindow && !overlayWindow.isDestroyed()`.

---

## 1. `index.ts` — window & app lifecycle

### Module-load side effects (before `app.whenReady`)

These run at import time, deliberately early:

- `installMainConsoleCapture()` — `index.ts:28`. Patches `console.*` first so the
  bridge-supervisor's spawn line and any early errors are buffered from process
  start (see §7).
- `app.disableHardwareAcceleration()` — `index.ts:32`. Hardware compositing can
  break overlay transparency (references electron/electron#25153).
- `Menu.setApplicationMenu(null)` — `index.ts:36`. Drops the default menu bar
  app-wide.
- `app.requestSingleInstanceLock()` — `index.ts:44`. If lost, `app.quit()`
  immediately and **run no startup** (see the single-instance section).

> **Non-obvious fact.** `supportsAttach = process.platform === 'win32' ||
> process.platform === 'linux'` (`index.ts:53`). `electron-overlay-window` can
> only attach to a real target window on **Windows or Linux (X11)**. Everywhere
> else — macOS, mainly during development — the code takes a *simulated-attach*
> path: a plain visible window plus a fake `attachSuccess`. `supportsAttach`
> gates every attach/focus/hotkey branch below.

### The overlay `BrowserWindow`

Created in `createOverlayWindow()` (`index.ts:66`). Options are `width: 900,
height: 670` spread over `OVERLAY_WINDOW_OPTS` from the library, plus
`webPreferences: { preload: '../preload/index.js', sandbox: false }`. The library
opts (from `electron-overlay-window/dist/index.js:21`) resolve per-platform to:

| Option | Value | Notes |
| --- | --- | --- |
| `frame` | `false` | frameless |
| `show` | `false` | shown only on attach / fallback |
| `transparent` | `true` | click-through HUD |
| `fullscreenable` | `true` | |
| `skipTaskbar` | `!isLinux` | hidden from taskbar except Linux |
| `resizable` | `!isLinux` | OS drives size from the target window |
| `hasShadow` | `!isMac` | no macOS shadow |
| `alwaysOnTop` | `isMac` | macOS floats it; on Win/Linux the library raises it |

Right after creation, `overlayWindow.setFocusable(false)` (`index.ts:80`) so the
window can't steal OS keyboard focus before the first interactive toggle. The
window loads `ELECTRON_RENDERER_URL` in dev, else `../renderer/index.html`
(`index.ts:82-86`).

### Attaching to the game (the `supportsAttach` fork)

**`supportsAttach` true** (`index.ts:88`): `OverlayController.attachByTitle(
overlayWindow, settings.gameWindowTitle, { hasTitleBarOnMac: true })`.

> **Non-obvious fact.** The title is matched by **exact strcmp** — not substring,
> not regex, case-sensitive. It must equal the live window title byte-for-byte.
> And the library can only attach **once per process**, so changing the
> configured title needs a full app restart — which is why `saveSettings`
> returns `needsRestart` (see §4).

Four library events are wired (`index.ts:96-112`):

| Event | Handler |
| --- | --- |
| `attach` | `gameHasFocus = true`; send `IPC.attachSuccess` to renderer |
| `focus` | `gameHasFocus = true` |
| `blur` | `gameHasFocus = false` (focus lost, game still open) |
| `detach` | `gameHasFocus = false`; send `IPC.overlayDetach` (game **closed** — renderer wipes session state like the DPS tracker) |

Then `installNoHideStrategy()` runs (see below).

**`supportsAttach` false** (`index.ts:115`): logs a notice, `setIgnoreMouseEvents(
true)`, `show()`, and after a `1000 ms` timer sends a simulated `IPC.attachSuccess`
so the renderer proceeds as if attached.

### `installNoHideStrategy()` — the alt-tab anti-flash

`index.ts:133`. The library hides the overlay on game-blur and re-shows on
focus; that re-show visibly *flashed*. This function monkey-patches
`overlayWindow.hide` so that on a normal blur it **sinks** the window
(`setAlwaysOnTop(false)` + `setIgnoreMouseEvents(true)`) instead of hiding it, so
it falls behind a covering window with the game and nothing animates. On
game-focus it re-raises with `setAlwaysOnTop(true, 'screen-saver')`. A real
`hide()` is preserved for **detach** only: a `prependListener('detach')` sets a
`detaching` flag so the patched `hide` calls the real one when the game actually
closes.

### Interactive vs. click-through — `toggleInteractive()`

`index.ts:161`. Flips `isInteractive` and swaps input ownership:

```
interactive  → setFocusable(true); attach ? activateOverlay()
                                         : setIgnoreMouseEvents(false)+focus()
click-through→ setFocusable(false); blur();
               attach ? focusTarget() : setIgnoreMouseEvents(true)
```

The `blur()` before `focusTarget()` matters (`index.ts:177-178`): it releases the
overlay's focus first so the OS doesn't bounce focus straight back, otherwise the
game would stay unfocused and need a manual click. Either way it ends by sending
`IPC.interactiveChange` with the new boolean so the renderer can style itself.

### The global toggle hotkey

`onToggleHotkey()` (`index.ts:194`) gate:

```
if (supportsAttach && !isInteractive && !gameHasFocus) return
toggleInteractive()
```

So the hotkey only pops the overlay **up** when the game has focus (won't
interrupt another app you alt-tabbed to), but can always toggle it **off** while
interactive. `registerHotkey(accelerator)` (`index.ts:199`) registers via
`globalShortcut` and updates `currentHotkey` only on success, returning the
boolean so `saveSettings` can detect a rejected accelerator. Default is
`Alt+Shift+R` (`shared/settings.ts`).

### Single-instance lock

`index.ts:44` grabs the lock at module load; `whenReady` bails immediately if it
was lost (`index.ts:212`).

> **Non-obvious fact.** A losing second launch must do **absolutely nothing** —
> in particular it must not run the bridge supervisor, whose reaper would
> force-kill the *first* instance's healthy bridge (leaving it bridgeless with no
> respawn). Hence `will-quit` only calls `stopBridge()` when
> `gotSingleInstanceLock` is true (`index.ts:330`). The `second-instance` event
> (`index.ts:205`) just does `overlayWindow?.showInactive()` to surface the
> existing overlay.

### IPC handlers registered here

All registered inside `whenReady` (`index.ts:283-384`). `handle` = renderer
`invoke` request/response; the pushes (`webContents.send`) are set up alongside.

| Channel (`IPC.*`) | Kind | Behaviour |
| --- | --- | --- |
| `getBridgeStatus` | handle | returns cached `currentBridgeStatus` |
| `getBufferedMainLogs` | handle | `getBufferedMainLogs()` (console backfill) |
| `getSettings` | handle | returns in-memory `settings` |
| `getAppVersion` | handle | `app.getVersion()` |
| `getSpritePack` | handle | `getSpritePack()` (cached pack) |
| `getUpdateStatus` | handle | `getCachedUpdate()` |
| `checkForUpdate` | handle | `checkForUpdate()` (GitHub query) |
| `downloadUpdate` | handle | download installer (streams `updateProgress`) then `installAndRestart` |
| `saveSettings` | handle | persist; may re-register hotkey; returns `SaveSettingsResult` (see §4) |
| `relaunch` | handle | `app.relaunch()` + `app.exit(0)` |
| `getPanelLayout` | handle | `loadPanelLayout()` |
| `savePanelLayout` | handle | `persistPanelLayout(panels)` |
| `reportBug` | handle | dumps the capture ring (below) + main logs to a gzipped JSON file, reveals it, opens the prefilled bug-report form; returns `BugReportResult` (`{file}`) |

Pushes to the renderer set up in the same block: `mainLogEntry`, `spritePack`,
`bridgeStatus`, `packetBatch`, `attachSuccess`, `overlayDetach`,
`interactiveChange`, `updateAvailable`, `updateProgress`.

### The "Report bug" capture ring

Every batch the bridge client delivers (`onBatch`, `index.ts`) is fanned out
two ways: pushed to the renderer as-is (`IPC.packetBatch`), and filtered into
`recentPackets`, an in-memory array that backs the `reportBug` handler. The
filtering/eviction logic (`pushCapturePacket`) and its policy constants
(`CAPTURE_ALLOWED_TYPES`, `CAPTURE_TYPE_QUOTAS`, `CAPTURE_RING_CAPACITY`) live
in `../shared/capture.ts`, not `index.ts` itself — it's imported by the
overlay's test suite too (the allowlist tripwire in
`test/allowlist.test.ts`; see [overlay-test-suite.md](overlay-test-suite.md)).

- **Default-deny allowlist.** Only types in `CAPTURE_ALLOWED_TYPES` are kept
  at all — the capture is attached to a **public** GitHub issue, so chat
  (`TextPacket`), account lists, and connection/auth packets never enter it,
  even though they still flow to the live overlay via `packetBatch`. See the
  bug-report privacy note in [bridge-server.md](bridge-server.md).
- **Ring capacity 10,000**, with per-type quotas (`CAPTURE_TYPE_QUOTAS`:
  `MovePacket` 500, `NewTickPacket` 1,000, `UpdateAckPacket`/`GotoAckPacket`
  300 each) so high-frequency "spam" types can't crowd out everything else
  and shrink the ring's wall-clock coverage; every other allowlisted type
  shares the remaining headroom under the overall cap. `pushCapturePacket`
  evicts oldest-of-that-type first for a quota-exceeding push, then
  oldest-of-any-type if the overall cap is still exceeded.
- **Output format.** `reportBug` serializes `{version, platform, arch,
  capturedAt, bridgeStatus, gameWindowTitle, recentPackets, mainLogs}` as
  compact (non-pretty-printed) JSON, gzips it (`zlib.gzipSync`), and writes
  `realmshark-bug-<ts>.json.gz` to the OS temp dir — comfortably under
  GitHub's 25 MB attachment limit even at full ring capacity.

### Quit / teardown

`will-quit` (`index.ts:387`): `globalShortcut.unregisterAll()`, then
`stopBridgeClient()` **before** `stopBridge()`.

> **Non-obvious fact.** Order matters: `stopBridge()` drops the bridge socket,
> whose `close` event would otherwise fire `onStatus('disconnected')` back into
> the already-destroyed overlay window. Severing the client first removes its
> listeners so that can't happen. `stopBridge()` itself is skipped for a losing
> second instance (see above). `window-all-closed` quits except on darwin
> (`index.ts:333`).

---

## 2. `bridgeSupervisor.ts` — spawning & reaping the bridge

Ensures a bridge is listening on `127.0.0.1:47474`. Constants at
`bridgeSupervisor.ts:7-20`: probe timeout `500 ms`, port-free poll `150 ms` up to
`3000 ms`, and auto-relaunch tuning (`RESTART_BACKOFF_MS = 2000`,
`RESTART_MAX = 5`, `RESTART_WINDOW_MS = 60_000`).

`ensureBridgeRunning(fake)` (`bridgeSupervisor.ts:174`) sequence:

```
reapOrphanedBridge()          # kill a bridge a prior run left alive
if isPortOpen(): return       # something's already listening → external bridge, don't spawn
spawn('java', ['-jar', jarPath(), ...(fake ? ['--fake'] : [])])
writePidFile(child.pid)
wire stdout/stderr → console.*, error, exit handlers
```

- **Locating java + the jar.** It spawns bare `java` (must be on `PATH`); a spawn
  `error` logs "is Java installed?" (`bridgeSupervisor.ts:203`).
  `jarPath()` (`bridgeSupervisor.ts:38`) is
  `process.resourcesPath/bridge.jar` when packaged, else
  `<__dirname>/../../../build/libs/bridge.jar` in dev.
- **`--fake` on non-Windows.** `index.ts:237` calls
  `ensureBridgeRunning(!supportsAttach)`, so on macOS/others the bridge runs with
  `--fake` (synthetic packets, no packet sniffing) — the same platforms that use
  simulated attach.
- **Child output** is routed through `console.log`/`console.error` (prefixed
  `[bridge]`), *not* `process.stdout`, so `consoleCapture` forwards it to the
  renderer console panel — the packaged app has no terminal.

### Orphan reaping & PID file

The bridge's capture layer is native (Npcap via the ardikars binding) and can
crash the JVM outright rather than throw. To avoid connecting to a stale,
non-capturing bridge (the "connected but zero packets" failure), the supervisor
records the spawned PID to `userData/bridge.pid` (`bridgeSupervisor.ts:50`).

`reapOrphanedBridge()` (`bridgeSupervisor.ts:142`): reads the pid file; if the
PID is our own or **not a live `java` process** (guards against a recycled PID),
it just clears the file. Otherwise it `forceKill`s and waits for the port to free
before returning. `isJavaPid` uses `tasklist` on Windows / `ps -o comm=`
elsewhere (`bridgeSupervisor.ts:103`); `forceKill` uses `taskkill /T /F` on
Windows (SIGTERM is unreliable for `java.exe`) / `SIGKILL` elsewhere
(`bridgeSupervisor.ts:124`).

> **Non-obvious fact.** A bridge the **user launched manually has no pid file**,
> so it is never reaped — the supervisor just connects to whatever is already
> listening on 47474. Only a bridge *this* project spawned is ever killed.

### Crash-loop respawn

The child `exit` handler (`bridgeSupervisor.ts:206`) skips respawn if
`intentionalStop` (an app quit) is set, else calls `scheduleRespawn(code)`.
`scheduleRespawn` (`bridgeSupervisor.ts:225`) prunes `restartTimes` to the rolling
60 s window, gives up after `RESTART_MAX = 5` restarts in that window (prevents a
CPU-spinning loop), otherwise waits `RESTART_BACKOFF_MS` and re-runs
`ensureBridgeRunning(lastFakeMode)`. A run that survives the window empties
`restartTimes`, restoring the full retry budget.

`stopBridge()` (`bridgeSupervisor.ts:258`) sets `intentionalStop = true`, cancels
any pending `respawnTimer`, force-kills the spawned PID (or the pid-file PID if we
adopted an orphan), and clears the pid file.

---

## 3. `bridgeClient.ts` — the WebSocket client

Connects to `ws://127.0.0.1:47474` (`bridgeClient.ts:4`) and reconnects on drop
(`RECONNECT_DELAY_MS = 2000`). Consumers pass a `BridgeClientHandlers` object
(`bridgeClient.ts:8`): `onStatus`, `onBatch`, optional `onConnected`, optional
`onSpritePack`.

### Hello-frame validation

On `open` it waits — it does **not** trust the connection yet. The first message
must be `{ type: 'hello', service: 'realmshark-bridge' }`
(`EXPECTED_SERVICE`, `bridgeClient.ts:5`). Only then does it flip `verified`,
fire `onStatus('connected')`, and call `onConnected(send)` handing back a
`send()` that JSON-stringifies to the socket. Any other first frame is logged and
the socket closed (`bridgeClient.ts:77`).

> **Non-obvious fact.** The hello gate means a *stray process squatting on port
> 47474* that isn't the bridge is treated as **disconnected**, not silently
> accepted — so the overlay doesn't sit "connected" against a wrong server.

### Message routing (post-verify)

| Received `msg` | Forwarded to |
| --- | --- |
| `msg.type === 'spritePack'` | `onSpritePack(msg)` → `spritePack.ts` (§6) |
| `Array.isArray(msg.batch)` | `onBatch(msg.batch)` → `IPC.packetBatch` |

The `onConnected` hook is used by `index.ts:252` to fire `requestSpritePack`, so
each (re)connect re-requests the pack. Wire shapes for `batch`, `dps`, sprite
pack, etc. live in `architecture.md` and `bridge-server.md`.

> **Note.** The task scope mentioned `dps` and `objectNames` messages, but this
> client only branches on `spritePack` and `batch`. DPS and object-name data
> arrive **inside** the `batch` array as packet envelopes and are demuxed in the
> renderer, not here — see `dps-engine.md` / `overlay-renderer.md`.

### Lifecycle

`startBridgeClient` resets `stopped = false` and connects; `stopBridgeClient`
(called from `will-quit`) sets `stopped = true`, removes all listeners from the
active socket, and closes it so no late `close`/`error` schedules a reconnect or
fires `onStatus` into a dead window (`bridgeClient.ts:38`). `close` →
`onStatus('disconnected')` + reconnect after 2 s (unless stopped); `error` logs
and closes.

---

## 4. Settings & config

**Model** (`shared/settings.ts`): `OverlaySettings = { gameWindowTitle,
toggleHotkey, textileAnimMs }`, with `DEFAULT_SETTINGS = { gameWindowTitle:
'RotMGExalt', toggleHotkey: 'Alt+Shift+R', textileAnimMs: 200 }`.
`gameWindowTitle` is the exact strcmp target for `attachByTitle` (§1).
`textileAnimMs` is the animated-textile-dye frame duration — see
`dyes-and-textiles.md`.

**Storage** (`settings.ts`): JSON at `app.getPath('userData')/settings.json`.
`loadSettings()` merges the file over `DEFAULT_SETTINGS` (so new keys pick up
defaults), and falls back to defaults on parse error. `persistSettings()` writes
pretty-printed JSON.

**`saveSettings` handler** (`index.ts:287`) is where settings changes take effect
at runtime:

- If `gameWindowTitle` changed → `needsRestart = true` in the result (attach
  can't be re-pointed live).
- If `toggleHotkey` changed → unregister the old accelerator and try the new one;
  if registration fails (invalid or already claimed), re-register the old one and
  report `hotkeyRegistered: false`. The persisted `toggleHotkey` keeps the old
  value in that case.
- `textileAnimMs` is clamped to `[50, 2000]` (falling back to `200` if the clamp
  math yields a falsy value) so a bad value can't stall or thrash the render
  loop, then pushed live to the overlay renderer via the `settingsChanged`
  IPC (`IPC.settingsChanged`) — no restart needed.

`SaveSettingsResult` (`shared/ipc.ts:42`) carries `{ needsRestart,
hotkeyRegistered }` back to the config UI, which then can offer `relaunch`.

**`configWindow.ts`** — a **separate** `BrowserWindow` (440×360, non-resizable,
titled "RealmShark Overlay Settings") that loads the same renderer bundle at the
`#config` route (`configWindow.loadURL(...'#config')` / `loadFile(..., { hash:
'config' })`). It's a singleton (`configWindow.focus()` if already open) and is
opened from the tray "Settings…" item. Unlike the overlay window it's a normal,
focusable, opaque window with the standard preload.

---

## 5. Panel layout

**Model** (`shared/panels.ts`): a `PanelInstance` is `{ id, type, anchor, size,
zIndex, pinned? }`. `Anchor` is percentage-based (`x`/`y` 0–100, `pos` currently
always `'tl'`) so positions stay correct when the overlay window resizes with the
game window. `pinned` (optional) keeps a panel visible in click-through mode.

**Persistence** (`panelLayout.ts`): JSON at `userData/panels.json`.
`loadPanelLayout()` returns `null` when the file is absent or unparseable — the
**renderer's panel registry owns the defaults**, main just stores whatever the
renderer sends. IPC: `getPanelLayout` (handle → `PanelInstance[] | null`) and
`savePanelLayout` (handle, void). The layout model and its consumption are a
renderer concern — see `overlay-renderer.md`.

---

## 6. `spritePack.ts` — main-side cache & serving

Owns the overlay's copy of the sprite pack (atlas PNGs as data URLs + rect
tables; full shape in `shared/ipc.ts:74`, semantics in `asset-pipeline.md` and
`dyes-and-textiles.md`). The renderer **never** talks to the bridge for sprites —
it reads this cache over IPC and receives pushes.

Cache lives at `userData/spritePack/pack.json`. `initSpritePack(notify)`
(`spritePack.ts:45`) loads any cached pack from disk and stores the
renderer-notify callback (`index.ts` wires it to `IPC.spritePack`).

Flow:

```
bridge (re)connects → onConnected → requestSpritePack(send)
   send { type:'spritePackRequest', haveVersion }
bridge replies { type:'spritePack', ... } → onSpritePackMessage
   upToDate?   → no-op (keep cache)
   !ready?     → keep existing cache; only downgrade to NOT_READY if we had none
   else        → replace current, saveToDisk, notifyRenderer
```

`requestSpritePack` (`spritePack.ts:55`) sends the version we already hold so an
unchanged version is a cheap no-op instead of re-shipping a multi-MB payload.

> **Non-obvious fact.** `haveVersion` is only sent when the cache **has
> `maskTable`, `dyeTable`, and `animTable`** (`spritePack.ts:59`). A cache that
> predates the dye/animation features matches on version but lacks that data;
> claiming `haveVersion = null`
> forces a full refetch so old caches self-heal. `getSpritePack()` serves the
> `IPC.getSpritePack` handle synchronously from memory.

---

## 7. `consoleCapture.ts`, `tray.ts`, `updater.ts`

### `consoleCapture.ts`

`installMainConsoleCapture()` (`consoleCapture.ts:27`) patches `console.log/info/
warn/error` to also record a `MainLogEntry { level, time, message }` into a
ring buffer (`MAX_ENTRIES = 300`) and push it to the registered sink. It's
installed at the very top of `index.ts` so pre-window logs (like the bridge spawn
line) are captured. `setMainLogSink(sink)` (`index.ts:218`) wires live entries to
`IPC.mainLogEntry`; `getBufferedMainLogs()` backfills the panel on mount via
`IPC.getBufferedMainLogs`.

> **Non-obvious fact.** The sink call is wrapped in try/catch (`consoleCapture.ts:
> 44`): a broken sink (window torn down mid-quit) must never make a `console.*`
> call throw, or it would abort whatever was logging — e.g. `stopBridge` during
> shutdown, leaving the bridge unkilled.

### `tray.ts`

`createTray(icon, { onToggleOverlay, onOpenSettings })` builds a `Tray` whose
context menu shows the live bridge status (a disabled label), **Show/Hide
Overlay** (→ `toggleInteractive`), **Settings…** (→ `openConfigWindow`), and
**Quit**. `setTrayStatus(status)` (called from the bridge `onStatus` callback)
re-renders the menu with the mapped label.

### `updater.ts` (brief — see `build-and-release.md`)

A lightweight self-updater that polls GitHub releases of
`white-bag/thessal` for a newer `vX.Y.Z[-alpha]` (or legacy
`overlay-test-vX.Y.Z`) tag with a `*-setup.exe` asset. **What triggers it:**
`startUpdatePolling` (`index.ts:266`) runs one check ~10 s after launch then every
6 h, and is a **no-op when unpackaged** (`app.isPackaged`); the config UI can also
call `checkForUpdate`/`downloadUpdate` on demand. On download it streams
`updateProgress`, then `installAndRestart` launches the NSIS installer detached
and quits (whose `will-quit` kills the bundled bridge's `java` so the installer
can overwrite `bridge.jar`). Deliberately not `electron-updater`; the tradeoffs
(unsigned, HTTPS + size check only) live in `build-and-release.md`.

---

## 8. Preload + the IPC contract (the renderer boundary)

`preload/index.ts` exposes a single object as `window.overlay` via
`contextBridge.exposeInMainWorld('overlay', overlayApi)` (`preload/index.ts:79`).
`index.d.ts` augments `Window` with `overlay: OverlayApi` so the renderer is
typed. The renderer may touch **nothing** outside this surface.

Two shapes of method:

- **`invoke` wrappers** return a `Promise` (request/response to an
  `ipcMain.handle`).
- **`on…` subscriptions** take a callback and **return an unsubscribe
  function**. Each attaches its own `ipcRenderer.on` listener that the
  unsubscribe removes - **except `onPacketBatch`**, the shared-fan-out
  exception: preload registers a single `ipcRenderer.on(IPC.packetBatch, …)`
  at module load and fans batches out to a `Set` of callbacks, so
  `onPacketBatch(cb)` adds/removes a Set member rather than its own IPC
  listener. That's also what lets `setPacketBatchSuspended` (below) buffer and
  replay batches to every current listener from one place. See the packet
  fan-out note in `overlay-renderer.md`.

| `window.overlay.*` | Channel (`IPC.*`) | Direction | Payload |
| --- | --- | --- | --- |
| `getBridgeStatus()` | `get-bridge-status` | invoke | → `BridgeStatus` |
| `onBridgeStatus(cb)` | `bridge-status` | main→rend | `BridgeStatus` |
| `onPacketBatch(cb)` | `packet-batch` | main→rend | `PacketEnvelope[]` |
| `setPacketBatchSuspended(b)` | *(none - preload-local)* | rend-local | `boolean` → void |
| `onInteractiveChange(cb)` | `interactive-change` | main→rend | `boolean` |
| `onAttachSuccess(cb)` | `attach-success` | main→rend | — |
| `onOverlayDetach(cb)` | `overlay-detach` | main→rend | — |
| `getSettings()` | `get-settings` | invoke | → `OverlaySettings` |
| `saveSettings(s)` | `save-settings` | invoke | `OverlaySettings` → `SaveSettingsResult` |
| `onSettingsChanged(cb)` | `settings-changed` | main→rend | `OverlaySettings` |
| `getAppVersion()` | `get-app-version` | invoke | → `string` |
| `relaunch()` | `relaunch-app` | invoke | → void |
| `getPanelLayout()` | `get-panel-layout` | invoke | → `PanelInstance[] \| null` |
| `savePanelLayout(p)` | `save-panel-layout` | invoke | `PanelInstance[]` → void |
| `onMainLogEntry(cb)` | `main-log-entry` | main→rend | `MainLogEntry` |
| `getBufferedMainLogs()` | `get-buffered-main-logs` | invoke | → `MainLogEntry[]` |
| `getSpritePack()` | `get-sprite-pack` | invoke | → `SpritePack` |
| `onSpritePack(cb)` | `sprite-pack` | main→rend | `SpritePack` |
| `getUpdateStatus()` | `get-update-status` | invoke | → `UpdateInfo \| null` |
| `checkForUpdate()` | `check-for-update` | invoke | → `UpdateInfo \| null` |
| `downloadUpdate()` | `download-update` | invoke | → void (emits `update-progress`) |
| `onUpdateAvailable(cb)` | `update-available` | main→rend | `UpdateInfo` |
| `onUpdateProgress(cb)` | `update-progress` | main→rend | `UpdateProgress` |

`setPacketBatchSuspended` is the one `window.overlay.*` method with no IPC
channel behind it - it only flips the local suspend flag preload checks before
fanning `packet-batch` out to `onPacketBatch` listeners (see above), so it
never crosses into the main process. Preload also force-clears the flag itself
on `interactive-change → false` and `overlay-detach` - a failsafe against a
drag whose `mouseup` never reaches the renderer (hotkey toggle mid-drag, game
closing), which would otherwise leave every packet-batch consumer frozen.

`IPC` (`shared/ipc.ts:2`) is the single source of truth for channel *names*;
`preload` and `index.ts` both import it so a rename can't drift between the two
sides. Shared types travel with it: `BridgeStatus`, `PacketEnvelope`,
`MainLogEntry` / `LogLevel`, `SpritePack`, `UpdateInfo`, `UpdateProgress`,
`SaveSettingsResult` (`shared/ipc.ts`), plus `OverlaySettings`
(`shared/settings.ts`) and `PanelInstance` (`shared/panels.ts`).

> **Non-obvious fact.** `sandbox: false` is set on both the overlay and config
> `webPreferences`. The preload therefore runs with Node integration available in
> its own scope, but the renderer still only sees the frozen `overlayApi` across
> the context bridge — no `ipcRenderer`, no `require`.

---

## Cross-references

- Bridge socket wire shapes / message types → `architecture.md`,
  `bridge-server.md`.
- `PacketEnvelope` / DPS demux → `dps-engine.md`, `overlay-renderer.md`.
- `SpritePack` contents & atlas rects → `asset-pipeline.md`,
  `dyes-and-textiles.md`.
- Panel UI / rendering of `PanelInstance` → `overlay-renderer.md`.
- Updater packaging / NSIS / signing tradeoffs → `build-and-release.md`.
