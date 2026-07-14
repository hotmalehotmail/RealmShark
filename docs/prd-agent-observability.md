# PRD — Agent Observability: closing the see-and-verify loop for cloud agents

**Status:** Accepted — implementation phased via issues (§9) · **Date:** 2026-07-14 · **Owner:** maintainer (hotmalehotmail)
**Companion docs:** [dev-loop-mechanisms.md](dev-loop-mechanisms.md) (loop mechanics), [build-agent-routine.md](build-agent-routine.md) (routine prompt)

---

## 1 · Problem statement

Cloud build-agent sessions underperform local sessions **not because of model or issue quality, but because of observability**. Verified against the full soak history (2026-07-11 → 2026-07-14):

- **24 alpha soaks across ~8 release waves; only 2 waves passed their first soak.** v0.14 took 6 alphas (4 explicit fails), v0.15 took 8, v0.17 took 4.
- **All 9 `soak:fail` reports fall into exactly two classes**, both invisible to a headless agent:
  - *Visual/layout* (~5): `{s.rotmg}` literal rendering (#89), clipped/pinned DPS rows & panel heights (#91, #93), colors/contrast (#113), sprite outline several px too thick (#147).
  - *Real-game data contracts* (~4): loot bags never recognized on real assets (#113, #144), equip/unequip counted as drops (#122), realm boss misattribution (#98), other players' damage missing (#50).
  - **Zero** failures were compile/crash/logic-against-fake-data bugs — CI's typecheck/lint/JUnit already catches everything the agent *can* measure.
- **The loot saga** (issue #105 → PR #106 → soak fails #113, #122, #136, #144 → PR #146) is the canonical failure: the agent assumed bag entities self-report `Class=Bag`+`BagType`; on real assets that scan finds nothing. Its fake test data (`IdToAsset.registerFake`) was generated *from the same assumption under test* — circular validation. Four live-game round-trips to fix what one line of real data would have prevented.
- **The "replayable capture" promise is aspirational.** The bug form calls the capture "the linchpin," but the overlay has **no test runner at all**, no harness consumes a `realmshark-bug-*.json`, and the one Java test written from a capture (`DpsEngineOtherPlayerAttributionTest`) was hand-transcribed by eye. Worse, the capture allowlist itself starved diagnosis: #144's capture couldn't contain the `lootBagTypes` envelope (only fixed as a side effect of PR #146).
- Both agents run Opus 4.8; issues are well-specified. Local sessions win because the human closes the observe→act loop in seconds (runs the app, looks, steers); the cloud loop closes it **once per alpha, through the maintainer's hands**.

**Thesis:** give the cloud agent (and the review agent) their own loop closure — eyes for the UI, replayable reality for the data — and move the human's visual check to the cheapest possible point.

## 2 · Goals

1. **G1 — the agent sees its UI before the PR opens.** Any UI-visible change is rendered and screenshotted headlessly; the agent must look and iterate.
2. **G2 — the maintainer sees screenshots before installing anything.** Visual verdicts happen from the soak issue (or PR), not after an install-and-play cycle.
3. **G3 — every live-game bug becomes a permanent replay test.** A capture attached to an issue becomes a committed fixture and a failing-then-passing regression test, on both the TS and (phase 2) Java sides.
4. **G4 — the agent works from real game data, not self-fulfilling fakes.** A committed capture corpus + a distilled asset-facts file are the ground truth for tests and for `FakePacketSource`.
5. **Success metrics** (baseline → target): soak first-pass rate 2/8 → most waves pass first soak; installs per shipped wave (currently up to 6–8) → 1–2; every `soak:fail` with a capture yields a committed replay fixture in the fix PR.

## 3 · Non-goals

- No pixel-golden CI gating (screenshot byte-diffs are flaky across environments; humans and multimodal review judge the images instead).
- No blocking human signoff **by default** — the loop stays hands-off; signoff is opt-in per issue (§5.4).
- No committed raw game assets — only distilled interop facts (§7.4) and allowlist-filtered captures.
- No live-game automation. The soak against the real client remains the final gate; the goal is to make first soaks *pass*, not to eliminate them.
- No `.github/workflows/` changes by agents (routine guardrail + review tripwire stand). All workflow-side integration is human/local work (§8).

## 4 · Locked decisions (ground truths)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Three-eyes screenshot model, non-blocking by default.** Build agent must look; review agent (multimodal) scores images against acceptance criteria; maintainer reviews a before/after gallery **in the soak issue**. Opt-in `ui:signoff` label makes it blocking for design-sensitive issues. | Exhaust cheap eyes before spending the human's; the soak issue is the already-designed human touchpoint, so no new interruption. Blocking-by-default would human-gate the most common PR type. |
| D2 | **Capture ring: ~10k envelopes with per-type quotas, compact JSON, gzipped.** | Agent read cost is irrelevant (programmatic). Real constraints: GitHub's 25 MB attachment limit (gzip solves) and spam-type eviction (`MovePacket`/`NewTickPacket` dominate a count-based ring; quotas stretch wall-clock coverage). |
| D3 | **Replay determinism via vitest fake timers + timestamp anchoring — no production clock refactor.** | `DpsTracker.ts:609` (`bossSnapshot(Date.now(), …)`), `useDpsTracker`'s `snapshot(Date.now())`, `LootTracker.ts:254` (`droppedAt`) compare envelope time against wall clock; a replayed capture from last week reads as "everything expired." `vi.setSystemTime` anchored to the capture's own timeline fixes this test-side. Injectable clock is the fallback only. |
| D4 | **TS replay first; Java replay mirror is phase 2 but required.** | Damage attribution is computed bridge-side (`DpsBroadcaster` runs `DpsEngine` and emits precomputed `type:"dps"` envelopes; the TS tracker only displays them). #50/#98-class bugs are Java bugs; replaying a capture's `dps` envelopes through TS reproduces the *display of wrong data*, not the bug. |
| D5 | **Capture corpus grows organically; seed once.** Per-issue attachment is the primary habit; every used capture is committed as a fixture by the agent's PR. One maintainer-recorded "kitchen-sink" session seeds the corpus as the agent's standing documentation of wire reality. A session-record toggle makes future recording free. | Pre-building a scenario matrix guesses at future needs; organic growth is targeted and self-maintaining. |
| D6 | **Asset facts = distilled JSON of only the fields the code consumes**, generated by a maintainer-run extractor per game update. Feeds headless tests and seeds `registerFake`. | Real asset semantics (bag entity classes, BagTypes, enchant strings) are exactly what agents have repeatedly guessed wrong. Facts-only data is small and defensible; raw assets are not committed. |
| D7 | **Screenshots live at stable per-panel paths, overwritten in place** (`docs/screenshots/panels/<type>-<size>.png`). | Stable paths make before/after trivial (same path at `bridge` vs `staging` refs), keep repo growth bounded, double as a living gallery, and let the PR body/review agent/soak issue all reference the same artifacts. |

---

## 5 · Feature 1 — Renderer harness & screenshot pipeline ("eyes")

### 5.1 Why it's feasible

The renderer is plain React + Tailwind; its **only** Electron dependency is the `window.overlay` API (`OverlayApi`, ~25 methods defined in `overlay/src/preload/index.ts`). Window attachment (`electron-overlay-window`) is irrelevant to "does the panel render correctly." Anything that provides `window.overlay` can host the renderer in ordinary headless Chromium.

### 5.2 Components

```
overlay/
  src/renderer/src/harness/
    shim.ts          # implements OverlayApi without Electron
    wsSource.ts      # live-fake mode: WS client straight to the bridge (mirrors bridgeClient.ts)
    fixtureSource.ts # fixture mode: load + play a capture/fixture JSON
  vite.harness.config.ts   # plain-vite config reusing the renderer plugins/aliases
  e2e/
    shots.spec.ts    # Playwright: mount each panel × size, screenshot
    playwright.config.ts
  test/fixtures/
    gallery.json         # standard fixture that populates every panel (for comparable shots)
    spritePack.json      # a captured spritePack message (fixture-mode sprites)
docs/screenshots/panels/ # committed gallery: <type>-<size>.png, overwritten in place
```

**The shim** (`shim.ts`) implements `OverlayApi`:
- `getSettings`/`getPanelLayout`/`savePanelLayout` → defaults + `localStorage`.
- `getBridgeStatus` → `connected`; `onAttachSuccess`/`onInteractiveChange` fire once with `interactive: true` so the panel canvas mounts (browser-side equivalent of the `toggleInteractive` recipe in CLAUDE.md).
- updater / `reportBug` / `relaunch` → no-ops.
- `onPacketBatch` / `onSpritePack` → wired to one of two data sources (below).

Bootstrap: `main.tsx` installs the shim **only when** `window.overlay` is undefined **and** `import.meta.env.VITE_HARNESS` is set. Production builds never set the flag; the packaged app is byte-equivalent in behavior.

**Data sources:**
1. **Live-fake mode** — a page-side WebSocket to `127.0.0.1:47474` against `gradle runBridge -Pargs="--fake"`. Parses the hello frame, `{"batch":[...]}` messages, and the `spritePack` message (~50 lines mirroring `overlay/src/main/bridgeClient.ts`). Real Java, real `FakePacketSource`, real sprite pack, zero Electron.
2. **Fixture mode** — `?fixture=<name>` loads a JSON file (a bug capture verbatim, or a hand-written scenario). Playback **rebases timestamps** (shift all `envelope.time` so the last batch ≈ `Date.now()` at load) so rolling-window logic renders sensibly, then delivers batches instantly (default) or paced. Sprites come from the committed `spritePack.json` fixture.

**Mount modes:** default = full panel canvas; `?panel=<type>&size=<sm|md|lg>` mounts a single panel from `registry.ts` at its preset dimensions — the unit for gallery shots.

### 5.3 The screenshot script

`npm run shots` (Playwright, Chromium only): starts the harness vite server, loads the **standard `gallery.json` fixture**, iterates every registered panel type × size, screenshots the panel node into `docs/screenshots/panels/<type>-<size>.png`. Deterministic by construction: fixed viewport & `deviceScaleFactor: 1`, animations disabled via a harness flag, one pinned Chromium (Playwright-pinned — the agent's Linux sandbox is the canonical environment; locally-generated shots are for viewing, not committing).

Note: `npm run dev` is electron-vite (spawns Electron); the harness uses a separate plain-vite config so no Electron/native modules are needed in the sandbox.

### 5.4 Loop integration

- **Build agent (routine prompt — BUILD & FIX modes):** *"If your change affects anything visible, run `npm run shots`, **Read the changed PNGs and look at them**, iterate until they match the acceptance criteria, commit them (stable paths), and embed the changed images in the PR body via raw URLs pinned to your head SHA."*
- **Review agent (`review.yml` prompt, human change, parity-guarded → `bridge` first):** *"If the diff touches `overlay/src/renderer/` or `docs/screenshots/`, Read the committed screenshots and evaluate them against the issue's visual acceptance criteria; a clear visual defect (placeholder text, clipping, unreadable contrast, obviously wrong proportions) is a finding like any other."* The judge already has the `Read` tool and is multimodal; no new tooling.
- **Soak issue gallery (`release.yml` alpha path, human change):** the soak-issue builder computes changed panels via `git diff --name-only origin/bridge..HEAD -- docs/screenshots/panels/` and embeds a before/after pair per changed panel: `raw.githubusercontent.com/<repo>/<bridge-sha>/…` vs `…/<staging-sha>/…` (SHA-pinned so superseded soak issues stay accurate). Maintainer flow: swipe the gallery → visually broken ⇒ `soak:fail` + comment **without installing**; looks right ⇒ install and behavior-test.
- **Opt-in blocking signoff:** maintainer puts **`ui:signoff`** on the *issue*. A small `pull_request_target` label-sync job (no checkout; reads the PR body's `Closes #N`, copies the label) propagates it to the PR. **Gatekeeper and sweep both** treat `ui:signoff` without `ui:approved` as a hold (alongside the existing soak-freeze / `session-done` / triage holds; the sweep must stay exactly as restrictive as the gatekeeper). Release: maintainer applies `ui:approved` (label = maintainer-only, same security model as every other verdict). Reject-with-steer: comment + `agent:retry` — existing `resume.yml` machinery. **No auto-release backstop**: unlike triage, this is a deliberate human gate; a held PR waits indefinitely.

### 5.5 Risks

- **Playwright browser download in the routine sandbox** may be blocked by network policy → maintainer adds the domain to the routine environment; agent fallback is any preinstalled Chromium; a failed download is reported under PR "Assumptions," never silently skipped.
- **Cross-platform rendering noise** → only sandbox-generated (pinned-Chromium) shots are committed; local output goes to a gitignored dir unless explicitly promoted.
- **Harness leaking into production** → shim import is dev-flag-gated and tree-shaken out of production builds; add a check to the build that the bundle contains no harness module.

---

## 6 · Feature 2 — Overlay test suite & capture replay

### 6.1 Core fact

`DpsTracker.ingest(packets: PacketEnvelope[])` and `LootTracker.ingest(packets: PacketEnvelope[])` consume **exactly** the array shape a bug capture's `recentPackets` field holds. Replay is nearly literal:

```ts
const capture = loadCapture('soak-144-loot-empty')       // handles .json and .json.gz
const tracker = new LootTracker()
replay(tracker, capture)                                  // fake-timer-anchored ingest
expect(tracker.entries.map(e => e.itemName)).toContain('<the white-bag item>')
```

Written against the capture attached to soak #144, that test fails on every build since PR #106 — the entire loot saga compressed into one red test.

### 6.2 Components

```
overlay/
  package.json           # + "test": "vitest run" (+ vitest devDependency)
  vitest.config.ts       # reuses tsconfig.web paths/aliases
  test/
    replay.ts            # loadCapture() + replay(tracker(s), capture, opts)
    fixtures/captures/   # <slug>.json[.gz] — the corpus (see Feature 3)
  src/shared/capture.ts  # CAPTURE_ALLOWED_TYPES + quotas move here (importable by main + tests)
```

**`replay.ts`:** accepts a full capture file (`{version, recentPackets, …}`) or a bare envelope array. Uses `vi.useFakeTimers()` + `vi.setSystemTime(firstEnvelope.time)`, then advances the fake clock to each envelope's `time` before ingesting it — so all rolling-window and `Date.now()` logic behaves exactly as it did live (D3). Helpers to snapshot mid-replay (`replayUntil(t)`) for asserting transient states.

**Allowlist tripwire:** every packet-stream consumer (`DpsTracker`, `LootTracker`, `EntityRegistry`, `ItemInfoProvider`, `StatusPanel`'s needs) exports a `CONSUMED_ENVELOPE_TYPES` const (derivable from each `ingest()` switch). A test asserts `CONSUMED ⊆ CAPTURE_ALLOWED_TYPES`. The allowlist stays default-deny for privacy; forgetting to extend it becomes a red test instead of a silently useless capture (the #144/#146 failure class).

### 6.3 Capture buffer upgrade (`overlay/src/main/index.ts`)

- Ring capacity: 300 → **10,000** envelopes total, with **per-type quotas** for spam types (initial: `MovePacket` 500, `NewTickPacket` 1,000, `UpdateAckPacket`/`GotoAckPacket` 300 each; everything else shares the remaining budget). Measure a real session and tune.
- Serialization: **compact** JSON (drop `null, 2`) + **gzip** → `realmshark-bug-<ts>.json.gz` (GitHub accepts `.gz` attachments; est. 3–10 MB for 10k envelopes, under the 25 MB limit).
- Allowlist unchanged in posture (default-deny, no chat/auth/credential types); its definition moves to `src/shared/capture.ts` for the tripwire test.

### 6.4 Regression-test contract (routine prompt, FIX/soak-fail modes)

*"If the work item includes or links a repro capture: download it, commit it under `overlay/test/fixtures/captures/<slug>.json.gz`, write a **failing** test that replays it and asserts the expected behavior from the report, then fix until green. The fixture and test ship in the same PR as the fix."*

### 6.5 Phase 2 — Java replay mirror

`src/test/java/bridge/replay/CaptureReplay.java`: parse capture envelopes with Gson; map `type` (the packet class simple name, same strings the TS switch uses) → packet class via `PacketType`; `gson.fromJson(env.data, clazz)` (viable because `PacketSerializer` reflects field names verbatim; enums serialize as name strings; the raw `byte[]` payload is excluded and not needed); feed the decoded packets through `DpsEngine` exactly as `DpsBroadcaster` does; assert on the emitted snapshot. Covers the attribution class (#50, #98). Explicitly out of scope: RC4/reassembly (replay starts from decoded packets). Replaces today's practice of hand-transcribing captures into Java tests.

### 6.6 CI

`ci.yml`'s overlay job adds `npm test` after lint (human/local change — agents can't touch `.github/`). The Java mirror runs under the existing `gradle test` step automatically.

---

## 7 · Feature 3 — Ground-truth corpus & asset facts

### 7.1 Capture-now button

Same code path as `reportBug` (`overlay/src/main/index.ts`) minus opening the issue form: dump the ring to `.json.gz`, reveal in folder. Exposed in the tray menu + Status panel. Implementation: parameterize the existing IPC handler (`reportBug({ openForm: false })`-style) rather than duplicating.

### 7.2 Session recorder

Settings toggle "Record session to disk": main process appends every **allowlisted** batch (same privacy posture as the ring — these files are meant to be shareable) as NDJSON to rolling `.ndjson.gz` files under `userData/captures/`, rotating at ~50 MB, keeping the last N files. Turns scenario recording into an afterthought and rescues the "bug happened before I pressed capture" case. Slicing stays manual/agent-side (the files are line-delimited envelopes; trivial to cut).

### 7.3 The corpus

`overlay/test/fixtures/captures/` with a `README.md` describing each fixture's scenario. Sources, in priority order:
1. **Per-issue attachments** (primary habit — see §7.5): committed by the agent's PR per §6.4.
2. **Soak-fail attachments**: same contract.
3. **One maintainer-recorded kitchen-sink seed** (`baseline-session`): ~20–30 min of varied play — dungeon with a boss phase change, realm event chain, white/orange bag drops, equip/unequip churn, players joining/leaving. Its role: the agent's standing **documentation of wire reality** (grep it to answer "what does a real `UpdatePacket` bag entity look like" during *any* task) and baseline coverage when an issue arrives with no fresh capture.

Privacy: allowlist filtering is automatic; maintainer eyeballs files before they land in the public repo (player names are visible — maintainer's call).

### 7.4 Asset facts

**Problem:** `IdToAsset`/`LootBagTypes`/enchant parsing read the game's extracted XML at runtime from a real install — their real behavior is unobservable and untestable headless, which is precisely what produced the loot saga.

**`AssetFactsExtractor`** (Java, building on the existing `assets/resextractor` machinery / `AssetProbeTest` prior art): runs where the game is installed (maintainer's Windows PC), distills **only the fields the code consumes** into a committed JSON (`assets/facts/asset-facts.json`, a few MB, facts-only — ids, names, numeric fields; no shipped assets):

```json
{
  "gameBuild": "<exalt build id>", "extractedAt": "2026-07-14", "generator": "AssetFactsExtractor v1",
  "items":    { "9064": { "name": "Sword of Acclaim", "bagType": 6, "tier": 12,
                           "slotType": 1, "damage": [220, 275] } },
  "entities": { "1292": { "id": "White Bag", "class": "<real class name>", "bagType": "<as-really-encoded>" },
                "1295": { "id": "Orange Bag", "class": "…" } },
  "enchants": { "17":   { "name": "Sharpened III", "rarity": 2, "desc": "+12% damage" } },
  "classes":  { "782":  { "name": "Wizard", "slotTypes": [2, 9, 5, 6] } }
}
```

Every top-level key exists because a soak failed without it: `items.*.bagType` = loot classification (#144); `entities.*` = the ground-truth answer to how bag entities really self-describe (the `Class=Bag` assumption dies here instead of in four soaks); `enchants.*` = the id→readable-text table (#113); item stats feed tooltips.

**Consumers:**
1. Headless tests (`LootBagTypesTest`, `IdToAssetBagIconTest`, enchant parsing) run against real facts in CI.
2. `IdToAsset.registerFake` is **seeded from the facts file** instead of invented values → `FakePacketSource` traffic uses real object types → `--fake` behavior converges toward live behavior for free.
3. Optionally the `--fake` bridge loads facts at runtime for realistic dev data on machines without a game install.

**Lifecycle:** maintainer reruns the extractor per game update; the file embeds `gameBuild` so staleness is detectable; growing it (new fields for new features) is part of "new data area" feature prep (§7.5).

### 7.5 Issue-template & process changes

- `feature.yml` gains a **Ground truth** textarea: *"Does this touch game data the overlay hasn't parsed before (new packet fields, asset XML, enchants…)? If yes, attach a capture (Capture-now button) and/or the relevant asset-facts fields — the agent cannot observe the live game."* (Precedent: issue #107's feasibility probe.)
- `bug_report.yml`: mention the `.json.gz` format; otherwise unchanged (the repro field already exists — now it's actually executable).

---

## 8 · Ownership split

Agents cannot touch `.github/` (routine guardrail + review tripwire) or the live routine config. The split:

| Change | Where | Owner |
|---|---|---|
| Harness, shim, Playwright, shots script, gallery fixture | `overlay/` | **Agent** (issue) |
| vitest, replay harness, tripwire, fixtures, capture-buffer upgrade | `overlay/` | **Agent** (issue) |
| Capture-now button, session recorder | `overlay/` | **Agent** (issue) |
| Asset-facts extractor + facts-seeded `registerFake` + facts tests | `src/`, `assets/` | **Agent** (issue, **with real XML samples attached**) — or local session |
| Java `CaptureReplay` + attribution replay tests | `src/test/` | **Agent** (issue, phase 2) |
| `ci.yml` `npm test` step | `.github/` | **Human/local PR** |
| `review.yml` screenshot-check prompt | `.github/` (parity-guarded → `bridge` first) | **Human/local PR** |
| `release.yml` soak-issue gallery | `.github/` | **Human/local PR** |
| Gatekeeper + sweep `ui:signoff` hold; label-sync job; `ui:signoff`/`ui:approved` labels | `.github/` + repo settings | **Human/local PR** |
| Issue-template Ground-truth field | `.github/` | **Human/local PR** |
| Routine prompt updates (shots step, `npm test` in self-check, capture→fixture contract) | routine config @ claude.ai/code/routines | **Human** (re-paste; doc edit alone doesn't take) |
| Routine env: Playwright download domain | routine config | **Human** |
| Kitchen-sink recording; extractor runs; capture eyeballing | Windows PC | **Human** |

Docs rule: each agent issue names its required `docs/` deliverable (new pages for the harness and the test/replay infra, indexed in `docs/README.md`; updates to `bridge-server.md`/`overlay-main-process.md` for the capture changes) so it doesn't cost a review round.

## 9 · Phasing

Sequential, one `agent:build` label at a time (these PRs overlap on `package.json`/`main.tsx`/docs — parallel agent PRs would churn the rebase loop):

1. **Phase 1 — Issue A (agent): test suite + replay + capture upgrade.** vitest; `replay.ts` (fake timers); fixtures committed from the *existing public* soak captures (#144, #122, #50 attachment URLs go in the issue); one regression test per fixture; allowlist tripwire; capture ring 10k/quotas/compact/gzip; docs. *Human follow-ups:* `ci.yml` `npm test`; routine-prompt self-check + capture→fixture contract.
2. **Phase 2 — Issue B (agent): harness + shots.** Shim, both data sources, `?panel/?size`, Playwright, `npm run shots`, gallery fixture + spritePack fixture, initial committed gallery, docs. *Human follow-ups:* routine-prompt shots step; `review.yml` screenshot check; Playwright domain in routine env; then `release.yml` soak gallery + `ui:signoff` holds (human PRs).
3. **Phase 3 — Issue C (agent): capture-now + session recorder.** *Human:* record the kitchen-sink session; commit `baseline-session` (attach to a small follow-up issue or hand to a local session).
4. **Phase 4 — Issue D (agent or local): asset facts.** Extractor + schema + facts-seeded `registerFake` + facts-based tests. **Gate: real XML fragments for every parsed element must be attached to the issue** (maintainer runs `resextractor` once) — otherwise this issue recreates the original failure mode. *Human:* run extractor, commit `asset-facts.json`.
5. **Phase 5 — Issue E (agent): Java `CaptureReplay`** + replay-based attribution tests over the by-then-existing corpus.

Soak cost of these PRs is near zero (shipped-behavior deltas: a dev-flag guard in `main.tsx`, a button, buffer sizing) — each wave's verdict is a quick smoke test, and phases 2+ progressively make their own verdicts cheaper.

## 10 · Risks & mitigations

| Risk | Mitigation |
|---|---|
| Playwright download blocked in routine sandbox | Routine env domain (human); fallback to preinstalled Chromium; failure reported in PR Assumptions, never silent |
| Screenshot nondeterminism → noisy before/afters | Single pinned sandbox environment produces all committed shots; animations disabled; fixed viewport/DPR; humans+multimodal judge images, no byte-diff gating (Non-goal) |
| Capture privacy on a public repo | Default-deny allowlist (unchanged) + maintainer eyeball before fixtures land; recorder writes allowlisted types only |
| Repo size growth (fixtures, PNGs) | Gz fixtures (MBs); gallery overwritten in place (D7); Git LFS as a later escape hatch |
| Asset-facts licensing | Facts-only interop data (ids/names/numeric fields), minimal, no asset binaries |
| `ui:signoff` PR waits forever if maintainer forgets | Acceptable by design (deliberate human gate, same posture as `agent:needs-human`); the label is opt-in per issue |
| Fake-timer replay diverges from live timing subtleties | Anchor to `envelope.time` (the same clock live code keys damage on); Java mirror cross-checks attribution independently |
| Harness code shipping to users | `VITE_HARNESS` flag + tree-shaking + a build-time assertion that production bundles contain no harness module |

## 11 · Open questions

1. Quota numbers in §6.3 are initial guesses — validate against a real session's type histogram before locking.
2. Should the soak gallery also embed shots for *unchanged* panels (full regression sweep) or only changed ones? (Start: changed only; revisit if unchanged-panel regressions slip through.)
3. `baseline-session` fixture size vs. CI time — if replaying 10k envelopes per test run gets slow, split the corpus into per-scenario slices and reserve the full session for targeted tests.
4. Does the routine sandbox provide a JDK (needed for live-fake mode's bridge jar)? Fixture mode carries the harness regardless; confirm on Issue B's first run.
