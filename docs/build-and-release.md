# Build, run & release

How to build, run, package, and release the two halves of this project: the Java
**bridge** (a fat jar built with Gradle) and the **overlay** (an Electron + React
app built with electron-vite and packaged with electron-builder). This is the
reference for the toolchain; for what each side *does* at runtime see
`bridge-server.md` (bridge protocol/flags) and `overlay-main-process.md` /
`overlay-renderer.md` (the Electron app). Architecture overview: `architecture.md`.

Every command below is verified against the actual config on the `bridge` branch;
where the repo-root `CLAUDE.md` drifts from those files it is called out inline.

## Files covered

| File | Role |
| --- | --- |
| `build.gradle` | Gradle build: `runBridge`, `bridgeJar`, full `shadowJar`, deps. |
| `gradlew` / `gradlew.bat` | Wrapper scripts — but the wrapper **jar is not committed** (see below). |
| `overlay/package.json` | npm scripts (`dev`/`build`/`typecheck`/`lint`/`build:*`), version, deps. |
| `overlay/electron.vite.config.ts` | Three-target (main/preload/renderer) electron-vite config. |
| `overlay/tsconfig*.json` | Split project references for `tsc` (node vs web). |
| `overlay/eslint.config.mjs` | Flat ESLint config. |
| `overlay/electron-builder.yml` | Packaging: bundles `bridge.jar`, NSIS installer, appId. |
| `overlay/src/main/updater.ts` | GitHub-releases auto-updater. |
| `.run/*.run.xml` | IntelliJ run configs. |

---

## 1. Java / bridge build (Gradle)

The Java side is a single Gradle project (`build.gradle` at the repo root). It
produces two different fat jars via the **Shadow** plugin, plus a dev run task.

### Tasks

| Task | Type | Output | Main-Class |
| --- | --- | --- | --- |
| `bridgeJar` | `ShadowJar` (`build.gradle:54`) | `build/libs/bridge.jar` (`build.gradle:59`) | `bridge.PacketBridge` (`build.gradle:61`) |
| `shadowJar` | `ShadowJar` (`build.gradle:99`) | `build/libs/RealmShark-v1.2.3.jar` (`build.gradle:103`) | `realmshark.RealmShark` (`build.gradle:65,101`) |
| `runBridge` | `JavaExec` (`build.gradle:41`) | runs in place | `bridge.PacketBridge` (`build.gradle:45`) |

- **`bridgeJar`** is the one the overlay ships — a self-contained fat jar for the
  WebSocket bridge only, named `bridge.jar` (no version in the filename). This is
  what `electron-builder.yml` bundles (see §3).
- **`shadowJar`** is the full RealmShark library fat jar; the overlay does not use
  it. Its filename embeds `project.version`, which is `v1.2.3` (`build.gradle:11`).
- **`runBridge`** runs the bridge headlessly from the classpath. Pass CLI args via
  `-Pargs=` (split on whitespace, `build.gradle:46-48`):

```bash
gradle runBridge -Pargs="--fake"          # synthetic packets, no game/Npcap
gradle runBridge -Pargs="--port 12345"    # listen on a custom port
```

**Runtime flags** (parsed in `src/main/java/bridge/PacketBridge.java:79-87`):
`--port <n>` (default **47474**) and `--fake` (emit synthetic packets instead of
sniffing). See `bridge-server.md` for what `--fake` simulates and the wire format.

### Dependencies added for the bridge

The bridge pulls in three libraries beyond the pcap/flatbuffers stack
(`build.gradle:31-37`):

| Dependency | Version | Used for |
| --- | --- | --- |
| `com.google.code.gson:gson` | 2.9.1 (`:34`) | Serializing packets to the JSON envelope. |
| `org.java-websocket:Java-WebSocket` | 1.5.7 (`:36`) | The loopback WebSocket server. |
| `com.google.flatbuffers:flatbuffers-java` | 23.5.26 (`:35`) | Sprite/mask atlas decode (asset pipeline). |

### Toolchain constraints (read before your first build)

> **Non-obvious fact — the Gradle wrapper jar is NOT committed.** `gradlew` and
> `gradlew.bat` exist, and `gradlew` references `$APP_HOME/gradle/wrapper/gradle-wrapper.jar`
> (`gradlew:83`), but that jar and the `gradle/wrapper/` directory do **not**
> exist in the repo. `./gradlew` will therefore fail. This is an
> IntelliJ-built project upstream; you must invoke a **system Gradle**, not the
> wrapper. Every recipe here uses `gradle`, not `./gradlew`.

> **Non-obvious fact — pin Gradle 7.4.2.** The Shadow plugin is version **7.0.0**
> (`build.gradle:6`), which breaks on **Gradle 9** (the current Homebrew default)
> with `Could not get unknown property 'convention'`. Use **Gradle 7.4.2**
> specifically.

- **JDK:** the project compiles to Java 8 bytecode (`sourceCompatibility` /
  `targetCompatibility = 1.8`, `build.gradle:8-9`), but Gradle 7.4.2 itself needs
  a JDK to run — use one it supports (JDK 8–17; the working recipe below uses
  JDK 17). On macOS the default `java` is a stub that opens java.com; do not trust
  a bare `java -version` to confirm a real JDK.

### Working recipe (macOS, matches CLAUDE.md)

```bash
curl -sSL -o /tmp/gradle-7.4.2-bin.zip https://services.gradle.org/distributions/gradle-7.4.2-bin.zip
unzip -q /tmp/gradle-7.4.2-bin.zip -d /tmp
export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"  # brew install openjdk@17
export PATH="$JAVA_HOME/bin:$PATH"
/tmp/gradle-7.4.2/bin/gradle bridgeJar        # -> build/libs/bridge.jar
```

---

## 2. Overlay build (npm + electron-vite)

The overlay lives in `overlay/` and is built with **electron-vite** (three
targets) and type-checked/linted separately. Run all npm commands from `overlay/`.
The current version is `0.9.26-alpha` (`overlay/package.json:3`).

### npm scripts (`overlay/package.json:7-21`)

| Script | Command | Notes |
| --- | --- | --- |
| `dev` (`:14`) | `electron-vite dev` | Dev with hot reload. On macOS this is the full dev loop (fallback window + `--fake` bridge); see `overlay-main-process.md`. |
| `build` (`:15`) | `npm run typecheck && electron-vite build` | Type-checks first, then builds all three targets to `out/`. |
| `typecheck` (`:12`) | `typecheck:node && typecheck:web` | Runs both project configs (below). |
| `typecheck:node` (`:10`) | `tsc --noEmit -p tsconfig.node.json --composite false` | main + preload. |
| `typecheck:web` (`:11`) | `tsc --noEmit -p tsconfig.web.json --composite false` | renderer. |
| `lint` (`:9`) | `eslint --cache .` | Add `--fix` for formatting-only warnings. |
| `format` (`:8`) | `prettier --write .` | — |
| `start` (`:13`) | `electron-vite preview` | Preview a built app. |
| `postinstall` (`:16`) | `electron-builder install-app-deps` | Rebuilds native deps after `npm install`. |
| `build:unpack` (`:17`) | `npm run build && electron-builder --dir` | Unpacked app dir, no installer. |
| `build:win` (`:18`) | `npm run build && electron-builder --win` | ⚠️ omits `--x64` — see §3 caveat. |
| `build:mac` (`:19`) | `electron-vite build && electron-builder --mac` | Skips typecheck (calls `electron-vite build` directly). |
| `build:linux` (`:20`) | `electron-vite build && electron-builder --linux` | Skips typecheck. |

> **Non-obvious fact — `build:mac`/`build:linux` skip type-checking.** Only
> `build` and `build:win` run `npm run build` (which type-checks first);
> `build:mac`/`build:linux` call `electron-vite build` directly. Run
> `npm run typecheck` yourself before those two if you want the check.

### electron-vite: three targets

`electron.vite.config.ts` defines one build per Electron process
(`electron.vite.config.ts:6-21`):

- **main** and **preload** use `externalizeDepsPlugin()` (Node deps stay external,
  not bundled).
- **renderer** uses `react()` + `tailwindcss()`, with `@renderer` aliased to
  `src/renderer/src` (`:14-19`).

Output goes to `out/`; the packaged app entry point is `./out/main/index.js`
(`overlay/package.json:4`).

### Split tsconfigs

`tsconfig.json` is a solution file that references two project configs
(`tsconfig.json:3`); it emits nothing itself:

| Config | Extends | Covers |
| --- | --- | --- |
| `tsconfig.node.json` | `@electron-toolkit/tsconfig/tsconfig.node.json` | `electron.vite.config.*`, `src/main/**`, `src/preload/**` |
| `tsconfig.web.json` | `@electron-toolkit/tsconfig/tsconfig.web.json` | `src/renderer/src/**`, `src/preload/*.d.ts`; sets `jsx: react-jsx` and the `@renderer/*` path |

Both declare `composite: true`, which is why the `typecheck:*` scripts pass
`--composite false` (so `tsc --noEmit` runs standalone rather than as a project
reference build).

### ESLint

Flat config (`eslint.config.mjs`): `@electron-toolkit` TS + prettier configs plus
the React / React-hooks / React-refresh plugins, ignoring `node_modules`, `dist`,
`out` (`eslint.config.mjs:9`).

> **Non-obvious fact — there is no overlay test suite.** `package.json` has no
> `test` script, and there is no vitest/jest config in `overlay/`. "Verifying" the
> overlay means running `npm run typecheck`, `npm run lint`, and the dev app
> (`npm run dev`) — see `overlay-main-process.md` for the macOS screenshot loop.

---

## 3. Packaging (electron-builder)

`overlay/electron-builder.yml` produces the distributable. Key settings:

| Setting | Value | Line |
| --- | --- | --- |
| `appId` | `com.realmshark.overlay` | `:1` |
| `productName` | `RealmShark Overlay` | `:2` |
| `win.executableName` | `overlay` | `:19` |
| NSIS `artifactName` | `${name}-${version}-setup.${ext}` | `:21` |
| `directories.buildResources` | `build` (i.e. `overlay/build/`) | `:4` |
| `npmRebuild` | `false` | `:25` |
| Output dir | `dist/` (electron-builder default; not overridden) | — |

With the current `name`/`version` (`realmshark-overlay` / `0.9.26-alpha`), the
installer is `overlay/dist/realmshark-overlay-0.9.26-alpha-setup.exe`.

### Bundling the bridge jar

```yaml
extraResources:
  - from: ../build/libs/bridge.jar
    to: bridge.jar
```

(`electron-builder.yml:15-17`) — this copies the Gradle output into the packaged
app's `resources/` directory as **`resources/bridge.jar`**, which the bridge
supervisor spawns at runtime (`overlay-main-process.md`). `asarUnpack` includes
`resources/**` (`:12-13`) so the jar stays a real file on disk, not packed inside
the asar.

> **Non-obvious fact — two different `build/` directories.** `from:
> ../build/libs/bridge.jar` reaches **up out of `overlay/`** to the repo-root
> Gradle output. That is unrelated to `directories.buildResources: build`, which
> is `overlay/build/` (electron-builder's icon/resource dir). Don't conflate them.

> **Ordering rule — rebuild the jar BEFORE packaging.** electron-builder copies
> whatever `../build/libs/bridge.jar` is on disk at package time; it does not
> trigger Gradle. If the Java side changed, run `gradle bridgeJar` (§1) first, or
> you will ship a stale bridge.

### The `--x64` caveat

> **Non-obvious fact — `npm run build:win` omits `--x64`.** The `build:win` script
> is `... electron-builder --win` (`overlay/package.json:18`), which defaults to
> the **host arch**. On Apple Silicon that is arm64 — wrong for a Windows gaming
> PC. Use the explicit form instead:

```bash
cd overlay
npm run build                       # typecheck + electron-vite build -> out/
npx electron-builder --win --x64    # -> dist/*-setup.exe (x64)
```

CLAUDE.md documents the `--x64` recipe correctly; the `build:win` npm script is
the arch-unsafe shortcut, so prefer the explicit command above for real releases.

---

## 4. Versioning

> **Single source of truth: `overlay/package.json`'s `version`
> (`overlay/package.json:3`).** It drives both the in-app version — shown in the
> Status panel via Electron's `app.getVersion()` — and the release tag/title (§6).
> Bump it *first*; everything else is derived, so the tag and the in-app version
> can't disagree.

Note the Java side has its own, unrelated version: `build.gradle:11` sets
`project.version = 'v1.2.3'`, which only affects the full `shadowJar` filename.
The bundled `bridge.jar` has no version in its name, so this never collides with
the overlay release number.

---

## 5. Auto-updater

`overlay/src/main/updater.ts` is a lightweight self-updater that polls GitHub
releases directly (it deliberately avoids `electron-updater`, since releases are
unsigned prereleases with custom tags and no `latest.yml` — `updater.ts:7-16`).

**What the code actually does:**

- **Target repo:** `white-bag/thessal` (`updater.ts:18`).
- **Polling:** first check ~10s after launch, then every 6h
  (`INITIAL_DELAY_MS` / `POLL_INTERVAL_MS`, `:19-20`). `startUpdatePolling` is a
  **no-op in dev** — it early-returns unless `app.isPackaged` (`:185`).
- **Check:** `checkForUpdate` GETs `/repos/{REPO}/releases?per_page=15` via Electron
  `net` (`:92`), skips drafts, parses each tag, keeps the highest, and returns it
  only if it beats the running `app.getVersion()` (`:95-109`). Prereleases are
  included on purpose (all releases are prereleases, so `/releases/latest` is
  useless — `:86-90`).
- **`parseTagVersion`** (`:43-47`) accepts both the current `vX.Y.Z` /
  `vX.Y.Z-alpha` semver tags **and** the legacy `overlay-test-vX.Y.Z` tags
  (regex `/^(?:overlay-test-)?v(\d+)\.(\d+)(?:\.(\d+))?/`), comparing on the numeric
  core only — so an older client still sees newer releases across the tag-scheme
  change.
- **Asset selection:** the first release asset whose name matches `/-setup\.exe$/i`
  (`:111`) — the NSIS installer.
- **Download:** `downloadInstaller` streams the asset to
  `<temp>/RealmShark-Overlay-<version>-setup.exe`, reports progress, and rejects on
  a size mismatch (HTTPS + size check only, **no signature verification** —
  `:128-165`).
- **Install:** `installAndRestart` spawns the installer **detached** and calls
  `app.quit()` (`:174-177`). The NSIS one-click installer replaces the app in place
  and relaunches it; quitting first lets `will-quit` kill the bundled `java.exe` so
  the installer can overwrite `resources/bridge.jar`.

The renderer is notified via the `onUpdate` callback wired in the main process
(see `overlay-main-process.md`); the updater module itself only checks,
downloads, and launches.

---

## 6. Release process (manual, not CI'd)

> ## ⚠️ NEVER cut a release unless the user explicitly asks in that message.
> Tagging, pushing a tag, and `gh release create` are a **stricter, separate
> gate** than the commit/push gate. Building and packaging locally to *verify* is
> fine; publishing is not — wait for an explicit "release" / "cut a release" /
> "ship it" in the user's current message. Do not infer it from earlier context.

When (and only when) asked, the flow is:

1. Bump `overlay/package.json` `version` to the new semver prerelease
   (e.g. `0.9.23-alpha`). Keeping it a valid prerelease makes GitHub auto-flag the
   release as a prerelease.
2. Rebuild `bridge.jar` (§1) **if the Java side changed** — electron-builder copies
   it as-is.
3. `cd overlay && npm run build && npx electron-builder --win --x64`.
4. Tag and release, deriving everything from `package.json` so nothing is
   hand-typed:

```bash
VERSION=$(node -p "require('./overlay/package.json').version")   # e.g. 0.9.23-alpha
TAG="v$VERSION"
git tag "$TAG" <commit> && git push origin "$TAG"
gh release create "$TAG" --repo white-bag/thessal --prerelease \
  --title "Overlay $TAG — ..." --notes "..." \
  overlay/dist/*-setup.exe#RealmShark-Overlay-Setup.exe build/libs/bridge.jar
```

**Tag scheme: plain semver `v$VERSION`** (e.g. `v0.9.23-alpha`) — **not** the
legacy `overlay-test-v…` prefix. GitHub only sorts the releases page correctly for
recognizable semver tags; the old prefix fell back to lexical order (so
`overlay-test-v0.9.10` sorted next to `0.9.1`). `parseTagVersion` still accepts the
old prefix (§5), so mixed history resolves.

**Artifacts attached:** the NSIS installer (uploaded/renamed to
`RealmShark-Overlay-Setup.exe`, which still matches the updater's `-setup.exe`
asset regex, case-insensitively) and `build/libs/bridge.jar`. The renamed
installer is what the auto-updater downloads.

---

## 7. IntelliJ run configs (`.run/`)

Two committed IntelliJ Application run configs (they just launch a main class with
a `Make` build step; no Gradle involved):

| Config | Main class | Args |
| --- | --- | --- |
| `PacketBridge.run.xml` | `bridge.PacketBridge` | `--fake` (synthetic packets) |
| `Potato.run.xml` | `potato.Potato` | none (the upstream Swing overlay; unrelated to the bridge/overlay work) |

`PacketBridge` with `--fake` is the fastest way to run the bridge from the IDE for
overlay development without the game or Npcap.

---

## CLAUDE.md drift notes

- CLAUDE.md's commands use `./gradlew`, but the wrapper jar is uncommitted, so
  `./gradlew` fails — its own toolchain recipe (further down) correctly uses a
  downloaded system Gradle 7.4.2. This doc uses `gradle` throughout.
- CLAUDE.md presents `npm run build:win` and `npx electron-builder --win --x64` as
  interchangeable. They are not: the `build:win` script omits `--x64`
  (`overlay/package.json:18`) and will target the host arch. Prefer the explicit
  `--x64` command for releases.
- Neither CLAUDE.md nor the release notes mention that `build.gradle` carries its
  own `project.version = 'v1.2.3'` (the RealmShark library version), separate from
  the overlay `version`. It only affects the full `shadowJar` filename, not the
  release.
