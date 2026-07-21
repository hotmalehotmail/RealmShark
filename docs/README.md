# RealmShark overlay — developer docs (`bridge` branch)

This directory documents the **overlay project** built on the `bridge` branch: a
Realm of the Mad God game overlay fed by decoded network packets. It has three
moving parts, each with its own doc below.

```
   RotMG client traffic
          │  (pcap / Npcap, Windows)
          ▼
  ┌──────────────────────┐   subscribes to every decoded Packet
  │ RealmShark (Java)    │   via Register.registerAll
  │ packet sniffer/decode│
  └──────────┬───────────┘
             ▼
  ┌──────────────────────┐   serializes packets to JSON, computes DPS,
  │ bridge/ (Java)       │   builds sprite packs, serves them over a
  │ WebSocket bridge     │   loopback WebSocket on 127.0.0.1:47474
  └──────────┬───────────┘
             ▼  ws://127.0.0.1:47474  (JSON batches)
  ┌──────────────────────┐   Electron + React + TypeScript.
  │ overlay/ (TypeScript)│   Attaches to the game window, draws
  │ Electron overlay UI  │   draggable panels (DPS, character, …).
  └──────────────────────┘
```

## Start here

- **[architecture.md](architecture.md)** — the end-to-end system: how a packet
  travels from the wire to a pixel on the overlay, the WebSocket wire protocol
  (envelopes, batches, hello frame, sprite-pack request), the port/process
  model, and how the pieces are launched and supervised. Read this first.

## Java side (`src/main/java/`)

- **[bridge-server.md](bridge-server.md)** — the WebSocket bridge: `PacketBridge`
  (entry point + flush/broadcast loop), `BridgeServer`, `PacketSerializer` (the
  Gson wire-format contract and its gotchas), `DpsBroadcaster`, `ObjectNames`,
  `LootBagTypes` (BagType 6/8 loot categorization), and `FakePacketSource`
  (`--fake` dev mode).
- **[dps-engine.md](dps-engine.md)** — the real DPS engine ported from `tomato`
  (`bridge/dps/**`): how per-player damage is reconstructed from the packet
  stream, weapon/ability/crucible/enchant scaling, character-stat decoding, and
  why self-damage has to be rebuilt.
- **[asset-pipeline.md](asset-pipeline.md)** — extracting sprites and object data
  from the game's Unity assets (`assets/**`), the flatbuffer sprite-sheet model,
  and how `SpritePackService` packages sprites (+ the dye table) for the overlay.
  See also **[dyes-and-textiles.md](dyes-and-textiles.md)**.

## Overlay side (`overlay/`)

- **[overlay-main-process.md](overlay-main-process.md)** — the Electron main
  process: the overlay window + game-window attach, the bridge supervisor/client,
  tray, global hotkey, settings & panel-layout IPC, preload, and the
  `shared/` contracts.
- **[overlay-renderer.md](overlay-renderer.md)** — the React renderer: the
  draggable/resizable panel system, the individual panels, the sprite-rendering
  subsystem, and the framework-agnostic `DpsTracker`/`LootTracker`.
- **[overlay-ui-style.md](overlay-ui-style.md)** — how the renderer's UI stays
  visually consistent: the semantic design tokens (Tailwind v4 `@theme`), the
  shared `ui/` primitives (`Button`, `MeterRow`, `GearRow`, …), the type
  scale, and the conventions the PR review agent enforces. **Read before
  writing any panel UI.**
- **[notifications.md](notifications.md)** — the overlay notification
  ("alerts") system: the framework-agnostic core (`AlertEngine`, the rule
  catalog including the `chat`-event `partyChat` rule, the multi-match
  dispatcher, the fired-alert store, the settings schema, the `SlotType` id →
  name table), its delivery layer (`AlertToastHost`'s banner stack, the
  coalesced ping sound), the Notifications history panel, and the per-panel
  settings gear — see `prd-notifications.md` for the full six-issue plan.
- **[overlay-testing.md](overlay-testing.md)** — the vitest suite
  (`overlay/test/`): the capture-replay harness (`loadCapture`/`replay`, fake-
  timer anchoring), the fixtures convention, the capture-allowlist tripwire,
  and the contract for turning a future bug capture into a regression test.
- **[dev-mode.md](dev-mode.md)** — the machine-local `devMode` settings flag
  (issue #265): what it gates (the Console panel and other debug surfaces,
  Status panel diagnostics, drag-perf instrumentation, the updater's
  alpha/beta/stable channel filtering), how it's set (hand-edited
  `settings.json`, no in-app UI), and how the screenshot harness forces it on.
- **[overlay-harness.md](overlay-harness.md)** — the browser renderer harness
  (`overlay/src/renderer/src/harness/`): hosting the React renderer in
  headless Chromium with no Electron process behind it, the live-fake and
  fixture data sources, the `?panel=&size=` single-panel mount mode, and the
  `npm run shots` deterministic screenshot pipeline that produces the
  committed gallery at `docs/screenshots/panels/`.

## Build, run & release

- **[build-and-release.md](build-and-release.md)** — Gradle tasks for the bridge
  jar (and the Gradle 7.4.2 constraint), the overlay's npm/electron-vite/
  electron-builder toolchain, how `bridge.jar` is bundled, versioning, and the
  auto-updater + release process.

## Reference

- **[dyes-and-textiles.md](dyes-and-textiles.md)** — how equipped dyes (solid
  colours and woven textiles) are decoded and composited onto character sprites.

## Autonomous dev loop (CI / agents)

- **[dev-loop-full-spec.html](dev-loop-full-spec.html)** — the end-to-end design
  spec (v5) for the issue-driven, mostly-hands-off dev loop: topology, how the
  layers hand off, what file enforces each rule, which model does what, worked
  feature/bug runs, and cost. This is the **design intent** the workflows cite as
  "full-spec §02/§03" — a point-in-time plan, not current-state docs, so parts
  describe behaviour not yet built (e.g. the review→builder fix loop and
  `gatekeeper.yml` auto-merge are still stubs).
- **[dev-loop-mechanisms.md](dev-loop-mechanisms.md)** — the per-step **mechanism
  ledger**: for every stage, exactly what *drives* it and what *enforces* it,
  whether it's built, and — for the unbuilt parts (fix loop, gatekeeper, review
  verdict, branch protection) — a precise spec including the 3-attempt cap and the
  human-escalation/resume flow. Reconciles the design intent above with the repo's
  actual state and gives the critical-path build order. A styled, viewable version
  is at [dev-loop-mechanisms.html](dev-loop-mechanisms.html) (same content).
- **[build-agent-routine.md](build-agent-routine.md)** — how a labeled issue
  becomes a PR: `implement.yml` fires the build-agent Routine over its `/fire`
  endpoint, and the one-time account-side setup.
- **[prd-agent-observability.md](prd-agent-observability.md)** — PRD: closing the
  see-and-verify loop for cloud agents. Evidence from the soak history (all
  failures are visual or real-game-data gaps invisible to a headless agent), the
  locked design decisions, and the technical design for the renderer screenshot
  harness, capture-replay test suite, ground-truth corpus, and asset-facts file —
  plus the agent/human ownership split and the phased issue plan. A styled,
  viewable version is at
  [prd-agent-observability.html](prd-agent-observability.html) (same content).
- **[prd-notifications.md](prd-notifications.md)** — PRD: the overlay notification
  system ("alerts"). Detector → catalog → dispatcher pipeline, the binding layering
  contract (swappable banner UI, one-catalog-entry extensibility), tiered
  `enchantedDrop` thresholds grounded in the asset facts, the per-panel settings
  gear, the `TextPacket` privacy constraint, and the six-issue implementation plan.
- **[prd-dps-graph.md](prd-dps-graph.md)** — PRD: the DPS trend sparkline
  (aggregate, trailing-average smoothed) and renderer-computed per-player
  average/peak DPS in the detail panel. The `DpsRateRecorder` snapshot-diffing
  design, the single-shared-`DpsTracker` refactor, the diagnosis of the
  "dps always 0" display bug it fixes, and the four-issue implementation plan.

---

> These docs describe the shipped implementation. They are written for both human
> contributors and AI coding agents — every non-obvious claim should be traceable
> to a `path:line` reference in the source. The authoritative quick-reference for
> commands and gotchas is the repo-root **`CLAUDE.md`**; these docs go deeper on
> how each subsystem actually works.
