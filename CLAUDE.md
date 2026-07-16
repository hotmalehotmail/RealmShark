# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Reference docs

`docs/` holds deep-dive documentation for each subsystem — fuller than this file. Consult the relevant one before changing a subsystem, and update it in the same PR whenever your change alters what it describes — a doc left inaccurate by your change is a defect, not a follow-up. This is enforced: the PR review agent treats an out-of-date (or now-wrong/incomplete) `docs/` file as a high-severity finding that fails the review-verdict gate and blocks the merge. New work that introduces a new subsystem, a new contract (wire format / IPC), or a cross-cutting mechanism must ship its own doc — a new `docs/` file (indexed in `docs/README.md`) or a substantial new section. Work that is merely another instance of an already-documented pattern (a new panel type, packet consumer, or dye), or an internal change that doesn't alter what a doc says, needs no doc change. `docs/README.md` is the index; key entries:

- `docs/architecture.md` — end-to-end system overview
- `docs/bridge-server.md` — the Java WebSocket bridge (packet → JSON → WS)
- `docs/dps-engine.md` — DPS attribution and computation
- `docs/overlay-main-process.md` / `docs/overlay-renderer.md` — the Electron app (main / renderer)
- `docs/asset-pipeline.md` / `docs/dyes-and-textiles.md` — sprite and dye/textile rendering
- `docs/build-and-release.md` — build, packaging, and release steps

## What this repo is

Two projects in one repo, on the `bridge` branch:

1. **RealmShark** (`src/main/java/`) — a Java library that sniffs Realm of the Mad God's network traffic at the packet level (via the `ardikars` pcap binding + Npcap on Windows) and decodes it into typed `Packet` objects. It reads only; it cannot modify, block, or send packets. This is a fork of `X-com/RealmShark` (`upstream` remote); `origin` is the fork `white-bag/thessal`.
2. **`overlay/`** — a separate Electron + React + TypeScript + Vite + Tailwind app: a game overlay UI fed by decoded packets over a local WebSocket bridge (`src/main/java/bridge/`). This is new work built on top of the upstream library, not part of it.

Upstream also has `tomato`/`potato` branches (full Swing GUI overlays built directly in Java) — useful prior art to check before reinventing something (e.g. DPS-meter attribution logic), via `git fetch upstream <branch>` + `git show upstream/<branch>:<path>`.

## Architecture

**Packet decoding pipeline** (`src/main/java/packets/`): `Sniffer`/`PProcessor` capture raw frames → `packets/packetcapture/pconstructor/ROTMGPacketConstructor` handles RC4 decryption/reassembly → `PacketType` enum maps a numeric opcode + direction to a `Packet` subclass constructor → `Register` (pub-sub) dispatches decoded `Packet` instances to any registered `IPacketListener`. Packet field names matter beyond Java — see "Wire format" below.

**The bridge** (`src/main/java/bridge/`): `PacketBridge` subscribes to `Register.registerAll`, serializes every packet via `PacketSerializer` (Gson, reflects field names verbatim, excludes the raw `byte[]` payload and login/device credential fields — `accessToken`/`platformToken`/`clientToken`/`userToken`/`password`) into a JSON envelope `{type, direction, time, data}`, and broadcasts batched `{"batch":[...]}` messages over a loopback-only WebSocket (`BridgeServer`) on **127.0.0.1:47474**. First message on every connection is a hello frame `{"type":"hello","service":"realmshark-bridge","protocol":1}` so a client can confirm it reached the real bridge. `FakePacketSource` (`--fake` flag) emits synthetic packets through the same `Register` pipeline for development without the game or Npcap — see "Local testing" below for what it simulates.

**The overlay** (`overlay/src/`):
- `main/index.ts` — creates the overlay `BrowserWindow`, attaches it to the game window via `electron-overlay-window` (Windows/Linux X11 only — see gotchas), owns the global toggle hotkey, tray, and settings/panel-layout IPC handlers.
- `main/bridgeSupervisor.ts` — probes `127.0.0.1:47474`; if nothing's listening, spawns the bundled `bridge.jar` itself, so the overlay is the only thing a user needs to launch.
- `main/bridgeClient.ts` — the WS client, validates the hello frame, reconnects on drop.
- `renderer/src/panels/` — a generic draggable/resizable panel system (percentage-anchored position + preset sm/md/lg sizes, not continuous resize — see `PanelCanvas.tsx`/`PanelFrame.tsx`/`anchor.ts`/`registry.ts`). New panel types are one registry entry (type → component + per-size pixel dims) plus a component matching `PanelContentProps` (`{ size }`).
- `renderer/src/dps/DpsTracker.ts` — plain, framework-agnostic class ingesting the packet stream: builds an `objectId → name` registry from `NAME_STAT` in `UpdatePacket`, an `objectId → ownerId` minion/pet map from `ServerPlayerShootPacket`, resolves the local player's identity from `CreateSuccessPacket`, and tracks a rolling-window (8s) DPS breakdown per enemy target. Focus is sticky on the game's current quest objective (`QuestObjectIdPacket` — the boss, in a dungeon) when one is set, carrying a boss's damage total forward across a phase/objectId change, and only moves when that target despawns or a new objective is set; outside a quest objective it falls back to whichever enemy the local player last hit. Resets on `MapInfoPacket` (instance change) and on `electron-overlay-window`'s `detach` event (game closed — distinct from `blur`, which is just focus loss).

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

Overlay tests: `npm test` (vitest, `overlay/test/`) — capture-replay regression tests (real/synthetic soak captures under `overlay/test/fixtures/captures/`, replayed through `overlay/test/replay.ts` with fake timers anchored to each envelope's `time`) plus an allowlist tripwire. See `docs/overlay-testing.md`. Every repro capture from a bug report or failed soak becomes a committed fixture + a failing-then-green test in the same PR as the fix. Visual changes: `npm run shots` regenerates the committed panel gallery under `docs/screenshots/panels/` (see `docs/overlay-harness.md`).

## Local testing without Windows or the game

`electron-overlay-window` only supports attaching to a real window on **Windows or Linux X11** — on macOS (or any other platform), the overlay automatically falls back to a plain visible window with a simulated attach event (see `supportsAttach` in `main/index.ts`), and the bridge supervisor passes `--fake` to the spawned bridge automatically on those platforms. So on macOS:

```bash
export PATH="/opt/homebrew/opt/openjdk@17/bin:$PATH"   # if `java -version` fails otherwise
cd overlay && npm run dev
```

This gives a fully working dev loop — real panels, real IPC, synthetic packet data — with zero Windows/game/Npcap dependency. `FakePacketSource.java` simulates: a stable 4-player named roster (`UpdatePacket`/`NAME_STAT`, every member fully equipped, two names carrying comma-appended title codes to exercise stripping), a `CreateSuccessPacket` assigning local-player identity to the first roster member, two distinct fake enemies, a fake pet/minion owned by the local player (`ServerPlayerShootPacket`), a non-local player's weapon swapping every ~10 ticks, a transient 5th player joining/leaving on a cycle (`UpdatePacket.drops`), periodic `MapInfoPacket`s to exercise instance-reset logic, and (via `IdToAsset.registerFake*`, seeded from the committed real-asset facts file `src/main/resources/assets/facts/asset-facts.json` — see `docs/asset-pipeline.md`'s "Asset facts" section; synthetic fallback values only when that resource is absent) the local player periodically picking up white/orange/untracked-bag items into their bag inventory slots (INVENTORY_4..11) to exercise the Loot panel — extend this file first if a new feature needs more realistic simulated traffic, rather than hand-rolling fake packets elsewhere.

To verify UI changes visually in this sandboxed environment: temporarily add a `setTimeout(() => toggleInteractive(), 1500)` in `main/index.ts`'s non-`supportsAttach` branch (so the panel canvas mounts without a real hotkey press), run `npm run dev` in the background, get the Electron window's position via `osascript` (`System Events` → `position of window 1`), and `screencapture -R<x>,<y>,<w>,<h>` that exact region — a full-screen screenshot usually just shows the desktop since the window is small and positioned arbitrarily. Revert the temporary toggle afterward. The same pattern (temporary `console-message` relay in `main/index.ts` + `console.log` in the code under test) is the way to get renderer-side diagnostics into the terminal, since Electron doesn't surface renderer console output by default.

## Autonomous agent dev-loop (branches, CI, agents)

This repo runs an issue-driven, mostly-hands-off development loop. The moving parts:

**Branch model.** `feature/*` / `fix/*` → `staging` (integration; alpha prereleases) → `bridge` (stable trunk; beta releases). **`bridge` is the GitHub default branch and the base for PRs** — not the stale `origin/main` or the upstream `realmshark` mirror. `staging` and `bridge` are both protected. Required checks on both: the two `ci` jobs (`overlay — typecheck + lint`, `bridge — compile + fat jar`), `review-verdict`, `pr hygiene`, and `workflow parity`; 0 human approvals; `enforce_admins` is off (the deliberate owner escape hatch — you can `--admin` merge a blocked PR).

**Kickoff.** File a GitHub Issue via the forms (`.github/ISSUE_TEMPLATE/`), then a maintainer applies `agent:build` (feature) or `agent:fix` (bug). Those maintainer-only labels are the trigger — opening an issue alone does nothing (the repo is public, so any stranger can open one). The bug form's **repro-capture** field is load-bearing: the fix agent runs headless with no game, so it needs a replayable packet capture (via `FakePacketSource`) to reproduce a live-client bug and write a regression test.

**CI / gates** (`.github/workflows/`). This is a summary — **`docs/dev-loop-mechanisms.md` is the authoritative, per-step ledger** (what drives each stage and what enforces it), kept current as the loop changes; consult it before touching any workflow, and update it in the same change. The thirteen workflows:
- `ci.yml` — the required merge gate. Overlay `typecheck`+`lint` (Node 22, `npm ci --ignore-scripts` — skips the native rebuild the Linux runner can't do) and `gradle test` (JUnit DPS tests) + `gradle bridgeJar`. Gradle 7.4.2 is pinned via `gradle/actions/setup-gradle` (no committed wrapper — `gradle/` is gitignored and Shadow 7.0.0 breaks on Gradle 9). A third **`workflow parity`** job fails any PR whose `review.yml` differs from the default branch — guarding the silent review-skip (a stale `review.yml` makes the reviewer skip green).
- `review.yml` — an independent code-review agent (Opus 4.8) on each PR, scoring **correctness + code quality + docs freshness + visual correctness** (when the diff touches `overlay/src/renderer/` or `docs/screenshots/`, the multimodal judge Reads the committed panel gallery and flags visual defects or stale/unrefreshed shots as findings). It posts inline findings and a machine-readable **`review-verdict`** commit status (`success`/`failure`) — the gate the rest of the loop reads. Authed via `CLAUDE_CODE_OAUTH_TOKEN` + the Claude GitHub App; needs `id-token: write`. Runs only when `review.yml` is byte-identical to the default branch (so it cannot review the PR that changes it; also skips a `staging → bridge` promotion). A skip posts **no** verdict, so the required `review-verdict` check fails closed rather than reading green. Also triggers on `edited` behind a relevance pre-step: a body edit that changes the *linked-issue reference* (or a base change) re-runs the review; any other edit keeps the existing verdict.
- `hygiene.yml` — model-free PR gates that re-run on every input mutation (`edited`, `labeled`): the **`pr hygiene`** required check (an agent PR must declare `Closes #N`; soak-fixes exempt — a body edit alone re-runs it, no commit needed) and a **duplicate guard** that auto-closes a newer open agent PR whose issue an older open PR already claims (branch kept). The `.github` tripwire deliberately stays in `review.yml`: `pull_request` workflows run from the merge ref, so `hygiene.yml` is self-certifiable by the PR under test, and only review.yml's byte-identity validation can't be faked.
- `gatekeeper.yml` — **live** (no longer an `if: false` stub). On `ci`/`review` completion it arms GitHub native auto-merge for a green `claude/*` PR into `staging` (using a short-lived `craig-the-intern-bot` App token, minted from `BOT_APP_ID`/`BOT_APP_PRIVATE_KEY`, so the merge fires downstream events) and **holds** unrelated agent PRs while an alpha soak is open, plus any PR labeled `ui:signoff` without `ui:approved` (the opt-in human visual gate — applying `ui:approved` re-arms instantly via a `pull_request: labeled` trigger; no timeout backstop, human gates wait). Conflicts are not its job: a conflicted PR emits **no** ci/review runs at all (GitHub can't build its merge ref), so a `workflow_run` trigger can never see one.
- `signoff.yml` — mirrors `ui:signoff`/`ui:approved` from an issue onto the open PR(s) closing it (`issues: labeled` + `pull_request_target`, API-only, no checkout), since gatekeeper/sweep evaluate PR labels. The hold itself lives in those two.
- `conflict-watch.yml` — conflict recovery. Fires on `pull_request_target` (which runs even for a conflicted PR — GitHub creates no `pull_request` runs while a PR has conflicts, the gap that silently stranded born-conflicted agent PRs) and on pushes to `staging` (the moment a sibling merge creates conflicts on the other open PRs), and re-fires the **originating** build agent in FIX MODE to rebase, via `.github/scripts/rebase-refire.sh` — its own `MAX_REBASE_ROUNDS` budget, deliberately separate from the review-fix budget so sibling-merge rebase churn can't freeze an innocent PR; escalates to `agent:needs-human` when spent. Never checks out PR-head code (the `pull_request_target` safety rule).
- `sweep.yml` — a level-triggered safety net (cron ~30 min) that merges any green, idle, un-armed `claude/*` PR the edge-triggered gatekeeper stranded, under the same restrictions (same-repo, no `--admin`, soak-freeze and `ui:signoff` hold respected); a conflicted (`DIRTY`) candidate is re-fired through the same rebase script as conflict-watch's backstop instead of skipped.
- `fixloop.yml` / `resume.yml` — the review-fix loop. On `review-verdict = failure` the build agent is re-fired in FIX MODE, capped at 3 attempts (marker-comment budget) before it escalates to `agent:needs-human`; applying `agent:retry` resets both budgets (review-fix + rebase) and re-fires — `resume.yml` triggers on `pull_request_target` so it also works on conflicted PRs, where `pull_request` events don't run.
- `implement.yml` — issue kickoff: an `agent:build`/`agent:fix` label fires the build-agent routine over its `/fire` endpoint (`ROUTINE_FIRE_URL`/`ROUTINE_FIRE_TOKEN`).
- `soak-verdict.yml` / `post-merge.yml` — the alpha-soak release loop. `soak:pass` promotes `staging → bridge` (a PR with a stamped `review-verdict`, via the `craig-the-intern-bot` App token); `soak:fail` fixes forward; a merge during a soak auto-cuts a fresh alpha, and the landed promotion cuts the latest release.
- `release.yml` — the human ship button (see Release process below).

**Where it runs.** Build/review agents run on Anthropic's cloud (Claude Code sessions / the action); the repo, CI, and releases on GitHub (Actions is free on this public repo); the alpha soak against the live game on the Windows PC.

**Commit posture.** Working on a `feature/*`/`fix/*` branch and opening a PR into `staging`/`bridge` is the normal way to land changes — pushing branch commits and opening PRs here does **not** need a separate ask. Never commit directly to `bridge`/`staging` (they're protected — use a PR). The release gate below is the one thing that stays strict.

## Release process

A CI release path exists: `.github/workflows/release.yml` (`workflow_dispatch`, channel `alpha`|`beta`) builds `bridge.jar` + the Windows installer on a `windows-latest` runner and publishes a prerelease. The manual recipe below still works and documents exactly what that workflow does.

**The CI dispatch auto-bumps the version** — no manual bump needed. It seeds from the latest published release tag, increments the patch, and applies the channel suffix (`v0.9.27-alpha` → `0.9.28-alpha` for alpha, `-beta` for beta), writes that into `overlay/package.json` in the runner (so the built app + installer name carry it), and tags/releases with it. Nothing is committed back — the **latest release tag is the source of truth** for the CI path, so the repo's `overlay/package.json` version is only a fallback seed and can lag. (Dispatch alpha from `staging`, beta from `bridge` — **enforced**: the workflow fails fast on a channel/ref mismatch, since the UI's ref dropdown defaults to `bridge` and a bridge-dispatched "alpha" rebuilds shipped content with an empty soak issue.) The manual recipe below is the exception: it still bumps `overlay/package.json` by hand.

**NEVER cut a new release (tag + `gh release create`, or dispatching `release.yml`) unless the user explicitly asks for it in that message.** Building/packaging locally to verify is fine; tagging, pushing tags, dispatching the release workflow, and publishing a GitHub release are not — wait for an explicit "release"/"cut a release"/"ship it". This gate is stricter than the commit/PR posture above: branch commits and PRs are fine unasked, but publishing a release is not.

`overlay/package.json`'s `version` is the single source of truth for the release number — it drives both the in-app version (shown in the Status panel via `app.getVersion()`) and the release tag/title below. Bump it *first*; everything else is derived from it, so the tag and the in-app version can't disagree.

**Tag scheme is a plain semver tag `v$VERSION`** (e.g. `v0.9.11-alpha`), NOT the old `overlay-test-v…` prefix. GitHub only sorts the releases page correctly when the tag is recognizable semver; the old prefix made it fall back to lexical order (so `overlay-test-v0.9.10` sorted down next to `0.9.1`). Keep `version` a valid semver prerelease (e.g. `0.9.11-alpha`) so GitHub also auto-treats it as a prerelease. `updater.ts`'s `parseTagVersion` accepts both the new `v…` tags and the legacy prefixed ones (numeric core only), so mixed history still resolves.

1. Bump `overlay/package.json`'s `version` to the new release number (a semver prerelease, e.g. `0.9.11-alpha`). *(Manual recipe only — the CI dispatch above does this step automatically.)*
2. Rebuild `bridge.jar` (Gradle, see above) if the Java side changed.
3. `cd overlay && npm run build && npx electron-builder --win --x64`.
4. Tag and release, deriving the tag/title straight from `package.json` so nothing is hand-typed:
   ```bash
   VERSION=$(node -p "require('./overlay/package.json').version")   # e.g. 0.9.11-alpha
   TAG="v$VERSION"
   git tag "$TAG" <commit> && git push origin "$TAG"
   gh release create "$TAG" --repo white-bag/thessal --prerelease \
     --title "Overlay $TAG — ..." --notes "..." \
     overlay/dist/*-setup.exe#RealmShark-Overlay-Setup.exe build/libs/bridge.jar
   ```

`overlay/electron-builder.yml`'s `extraResources` bundles `../build/libs/bridge.jar` into the packaged app as `resources/bridge.jar` — always rebuild the jar *before* packaging if the Java side changed, since electron-builder just copies whatever's currently on disk.

## Known constraints worth remembering

- **Bridge port is 47474**, not 8080 — changed early on to avoid collisions with common dev-server ports.
- **`electron-overlay-window` matches the target window title with an exact `strcmp`**, not a substring — must match byte-for-byte including case. The real RotMG client window is titled `RotMGExalt` (confirmed live, not `"Realm of the Mad God"` as initially assumed) — this is now user-configurable via the overlay's Settings window rather than hardcoded, precisely because it turned out to be fragile.
- **No elevation/UAC needed for packet capture.** Confirmed from the upstream README: Tomato/Potato have never required running as Administrator for normal capture (only for the unrelated `jarfix` tool). Npcap's installer defaults to *not* restricting the driver to admin-only.
- **Single-instance lock** (`app.requestSingleInstanceLock()`) prevents a second overlay launch (or a crash-orphaned process) from leaving a duplicate supervised `bridge.jar` running.
