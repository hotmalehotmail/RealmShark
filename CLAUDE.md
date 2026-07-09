# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

Two projects in one repo, on the `bridge` branch:

1. **RealmShark** (`src/main/java/`) — a Java library that sniffs Realm of the Mad God's network traffic at the packet level (via the `ardikars` pcap binding + Npcap on Windows) and decodes it into typed `Packet` objects. It reads only; it cannot modify, block, or send packets. This is a fork of `X-com/RealmShark` (`upstream` remote); `origin` is the fork `hotmalehotmail/RealmShark`.
2. **`overlay/`** — a separate Electron + React + TypeScript + Vite + Tailwind app: a game overlay UI fed by decoded packets over a local WebSocket bridge (`src/main/java/bridge/`). This is new work built on top of the upstream library, not part of it.

Upstream also has `tomato`/`potato` branches (full Swing GUI overlays built directly in Java) — useful prior art to check before reinventing something (e.g. DPS-meter attribution logic), via `git fetch upstream <branch>` + `git show upstream/<branch>:<path>`.

## Architecture

**Packet decoding pipeline** (`src/main/java/packets/`): `Sniffer`/`PProcessor` capture raw frames → `packets/packetcapture/pconstructor/ROTMGPacketConstructor` handles RC4 decryption/reassembly → `PacketType` enum maps a numeric opcode + direction to a `Packet` subclass constructor → `Register` (pub-sub) dispatches decoded `Packet` instances to any registered `IPacketListener`. Packet field names matter beyond Java — see "Wire format" below.

**The bridge** (`src/main/java/bridge/`): `PacketBridge` subscribes to `Register.registerAll`, serializes every packet via `PacketSerializer` (Gson, reflects field names verbatim, only excludes the raw `byte[]` payload) into a JSON envelope `{type, direction, time, data}`, and broadcasts batched `{"batch":[...]}` messages over a loopback-only WebSocket (`BridgeServer`) on **127.0.0.1:47474**. First message on every connection is a hello frame `{"type":"hello","service":"realmshark-bridge","protocol":1}` so a client can confirm it reached the real bridge. `FakePacketSource` (`--fake` flag) emits synthetic packets through the same `Register` pipeline for development without the game or Npcap — see "Local testing" below for what it simulates.

**The overlay** (`overlay/src/`):
- `main/index.ts` — creates the overlay `BrowserWindow`, attaches it to the game window via `electron-overlay-window` (Windows/Linux X11 only — see gotchas), owns the global toggle hotkey, tray, and settings/panel-layout IPC handlers.
- `main/bridgeSupervisor.ts` — probes `127.0.0.1:47474`; if nothing's listening, spawns the bundled `bridge.jar` itself, so the overlay is the only thing a user needs to launch.
- `main/bridgeClient.ts` — the WS client, validates the hello frame, reconnects on drop.
- `renderer/src/panels/` — a generic draggable/resizable panel system (percentage-anchored position + preset sm/md/lg sizes, not continuous resize — see `PanelCanvas.tsx`/`PanelFrame.tsx`/`anchor.ts`/`registry.ts`). New panel types are one registry entry (type → component + per-size pixel dims) plus a component matching `PanelContentProps` (`{ size }`).
- `renderer/src/dps/DpsTracker.ts` — plain, framework-agnostic class ingesting the packet stream: builds an `objectId → name` registry from `NAME_STAT` in `UpdatePacket`, an `objectId → ownerId` minion/pet map from `ServerPlayerShootPacket`, resolves the local player's identity from `CreateSuccessPacket`, and tracks a rolling-window (8s) DPS breakdown per enemy target, focused on whichever enemy the local player last hit. Resets on `MapInfoPacket` (instance change) and on `electron-overlay-window`'s `detach` event (game closed — distinct from `blur`, which is just focus loss).

## Wire format gotcha

The bridge's JSON is a direct reflection of Java field names (Gson, no custom serializers for packet data), so any TypeScript type consuming it must match the Java class's public fields exactly — check the actual `packets/incoming/*.java` / `packets/data/*.java` source before writing a new consumer, not just the wire output, since enums serialize as their name string (e.g. `"statType": "NAME_STAT"`) and nested data classes reflect their own fields the same way.

## Commands

### Java / bridge (Gradle)

```bash
./gradlew runBridge -Pargs="--fake"   # run the bridge headlessly with synthetic packets, no game/Npcap needed
./gradlew runBridge -Pargs="--port 12345"
./gradlew bridgeJar                   # standalone fat jar, bridge.PacketBridge only -> build/libs/bridge.jar
./gradlew shadowJar                   # full RealmShark fat jar (library, not the bridge)
```

**No committed Gradle wrapper jar** (`gradlew` exists but `gradle-wrapper.jar`/`.properties` don't — this is an IntelliJ-built project upstream). **Gradle 9 (current Homebrew default) breaks the Shadow 7.0.0 plugin** (`Could not get unknown property 'convention'`) — use **Gradle 7.4.2** specifically:

```bash
curl -sSL -o /tmp/gradle-7.4.2-bin.zip https://services.gradle.org/distributions/gradle-7.4.2-bin.zip
unzip -q /tmp/gradle-7.4.2-bin.zip -d /tmp
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"  # or any JDK 11+
export PATH="$JAVA_HOME/bin:$PATH"
/tmp/gradle-7.4.2/bin/gradle bridgeJar
```

If `openjdk@17` isn't installed: `brew install openjdk@17`. macOS's default `java` is a bare stub that just opens the java.com download page — do not rely on plain `java -version` to check for a real JDK.

### Overlay (`overlay/`, npm + electron-vite)

```bash
npm run dev          # electron-vite dev, hot reload
npm run typecheck    # tsc, both main and renderer configs
npm run lint         # eslint (run `npx eslint --fix .` for formatting-only warnings)
npm run build        # typecheck + electron-vite build (out/)
npx electron-builder --win --x64   # packaged Windows installer -> dist/*.exe (must specify --x64 explicitly; defaults to host arch, e.g. arm64 on Apple Silicon, which is wrong for a Windows gaming PC)
```

No test suite exists for the overlay yet.

## Local testing without Windows or the game

`electron-overlay-window` only supports attaching to a real window on **Windows or Linux X11** — on macOS (or any other platform), the overlay automatically falls back to a plain visible window with a simulated attach event (see `supportsAttach` in `main/index.ts`), and the bridge supervisor passes `--fake` to the spawned bridge automatically on those platforms. So on macOS:

```bash
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"   # if `java -version` fails otherwise
cd overlay && npm run dev
```

This gives a fully working dev loop — real panels, real IPC, synthetic packet data — with zero Windows/game/Npcap dependency. `FakePacketSource.java` simulates: a stable 4-player named roster (`UpdatePacket`/`NAME_STAT`), a `CreateSuccessPacket` assigning local-player identity to the first roster member, two distinct fake enemies, a fake pet/minion owned by the local player (`ServerPlayerShootPacket`), and periodic `MapInfoPacket`s to exercise instance-reset logic — extend this file first if a new feature needs more realistic simulated traffic, rather than hand-rolling fake packets elsewhere.

To verify UI changes visually in this sandboxed environment: temporarily add a `setTimeout(() => toggleInteractive(), 1500)` in `main/index.ts`'s non-`supportsAttach` branch (so the panel canvas mounts without a real hotkey press), run `npm run dev` in the background, get the Electron window's position via `osascript` (`System Events` → `position of window 1`), and `screencapture -R<x>,<y>,<w>,<h>` that exact region — a full-screen screenshot usually just shows the desktop since the window is small and positioned arbitrarily. Revert the temporary toggle afterward. The same pattern (temporary `console-message` relay in `main/index.ts` + `console.log` in the code under test) is the way to get renderer-side diagnostics into the terminal, since Electron doesn't surface renderer console output by default.

## Release process (manual, not yet CI'd)

**NEVER cut a new release (tag + `gh release create`) unless the user explicitly asks for it in that message.** Building/packaging locally to verify is fine; tagging, pushing tags, and publishing a GitHub release are not — wait for an explicit "release"/"cut a release"/"ship it". This is separate from and stricter than the general commit/push gate.

1. Rebuild `bridge.jar` (Gradle, see above) if the Java side changed.
2. `cd overlay && npm run build && npx electron-builder --win --x64`.
3. `git tag overlay-test-vX.Y <commit>` and `git push origin overlay-test-vX.Y`.
4. `gh release create overlay-test-vX.Y --repo hotmalehotmail/RealmShark --prerelease --title "..." --notes "..." overlay/dist/*-setup.exe#RealmShark-Overlay-Setup.exe build/libs/bridge.jar`.

`overlay/electron-builder.yml`'s `extraResources` bundles `../build/libs/bridge.jar` into the packaged app as `resources/bridge.jar` — always rebuild the jar *before* packaging if the Java side changed, since electron-builder just copies whatever's currently on disk.

## Known constraints worth remembering

- **Bridge port is 47474**, not 8080 — changed early on to avoid collisions with common dev-server ports.
- **`electron-overlay-window` matches the target window title with an exact `strcmp`**, not a substring — must match byte-for-byte including case. The real RotMG client window is titled `RotMGExalt` (confirmed live, not `"Realm of the Mad God"` as initially assumed) — this is now user-configurable via the overlay's Settings window rather than hardcoded, precisely because it turned out to be fragile.
- **No elevation/UAC needed for packet capture.** Confirmed from the upstream README: Tomato/Potato have never required running as Administrator for normal capture (only for the unrelated `jarfix` tool). Npcap's installer defaults to *not* restricting the driver to admin-only.
- **Single-instance lock** (`app.requestSingleInstanceLock()`) prevents a second overlay launch (or a crash-orphaned process) from leaving a duplicate supervised `bridge.jar` running.
