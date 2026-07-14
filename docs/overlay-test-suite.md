# Overlay test suite & capture replay

**Companion:** [`docs/prd-agent-observability.md`](prd-agent-observability.md)
§6 is the design doc this implements (issue #157, PRD Phase 1). This page
documents the shipped implementation.

## Why this exists

`DpsTracker.ingest(packets: PacketEnvelope[])` and
`LootTracker.ingest(packets: PacketEnvelope[])` (see
[overlay-renderer.md](overlay-renderer.md)) consume **exactly** the envelope-array
shape a "Report bug" capture's `recentPackets` field holds. That makes a real
soak-failure capture replayable through the actual tracker code almost for
free — turning a one-off bug report into a permanent regression test, instead
of a hand-transcribed approximation of what the wire traffic looked like.

## Running the suite

```bash
cd overlay
npm test          # vitest run
```

`vitest.config.ts` reuses `tsconfig.web`'s `@renderer` alias (see
`electron.vite.config.ts`'s renderer block) via a plain resolve alias, and
runs in Vitest's default `node` environment — the trackers under test are
framework-agnostic classes with no DOM dependency, so no `jsdom`/`happy-dom`
is installed.

## `test/replay.ts` — the replay harness

Two entry points:

- **`loadCapture(path)`** reads a fixture from disk. Accepts `.json` or
  `.json.gz` (gzip-detected by extension, matching the "Report bug" handler's
  output — see [overlay-main-process.md](overlay-main-process.md)), and either
  a full capture file (`{..., recentPackets: [...]}`) or a bare envelope array
  (so a hand-synthesized fixture doesn't need the wrapper).
- **`replay(trackers, packets, opts?)`** feeds `packets` through one or more
  `Ingestible`s (anything with an `ingest(packets: PacketEnvelope[])` method —
  both `DpsTracker` and `LootTracker` satisfy this) one envelope at a time,
  wrapping the whole thing in `vi.useFakeTimers()`.

### Fake-timer anchoring (the load-bearing part)

`DpsTracker.snapshot()` calls `bossSnapshot(Date.now(), WINDOW_MS)`
(`DpsTracker.ts`) and `LootTracker` stamps `droppedAt: Date.now()` on every
logged entry — both compare against the **wall clock**, not the envelope's
own `time` field. Replaying a week-old capture without anchoring the clock
means every rolling-window check reads "already expired" and every assertion
about "did this happen recently" is meaningless.

`replay()` sets `vi.setSystemTime(envelope.time)` before ingesting each
envelope, so `Date.now()` inside tracker code returns that envelope's own
timestamp — the same clock relationship the tracker had live. This is
test-side only (per PRD D3): no production clock injection, no changes to
`DpsTracker`/`LootTracker` themselves.

```ts
const packets = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
const tracker = new LootTracker()
replay(tracker, packets)
expect(tracker.entriesFor(6)).toEqual([])
```

### `replayUntil` — mid-replay snapshots

`replayUntil(trackers, packets, untilTime, opts?)` feeds only envelopes up to
`untilTime`, then **pins the fake clock there and returns without restoring
real timers** — so the caller can immediately read `Date.now()`-based tracker
state (e.g. a boss encounter mid-fight) at that exact point in the capture's
timeline. Unlike `replay()`, the caller owns cleanup: call
`vi.useRealTimers()` once done inspecting the snapshot. Both functions also
accept an `opts.onStep(envelope, index)` hook, invoked after each envelope —
the lighter-weight alternative when you just need to observe one field
changing partway through rather than stop and snapshot.

## The fixture corpus (`test/fixtures/captures/`)

Real "Report bug" captures from past alpha-soak failures, committed gzipped.
**A capture's usefulness for a regression test is bounded by what it actually
contains** — the ring buffer that produced it may have rotated past the
triggering traffic, or (for older captures) predate a fix that added a new
envelope type to the allowlist. `test/fixtures/captures/README.md` documents
each fixture's contents and exactly what it can and can't test; read it
before assuming a capture supports the assertion you want. Where a real
capture can't support the ideal positive-case assertion (e.g. no committed
fixture contains a real white/orange bag drop), the corresponding test
synthesizes a minimal, wire-accurate variant instead — see
`test/loot.replay.test.ts`'s "synthesized true drop" case.

New fixtures are added the same way: gzip the capture, commit it under
`test/fixtures/captures/`, and add an entry to that README describing what it
contains and why. Per the PRD's regression-test contract (§6.4): if a future
FIX-mode work item includes or links a repro capture, download it, commit it
as a fixture, and write a **failing** test replaying it before fixing the bug.

## Allowlist tripwire (`test/allowlist.test.ts`)

`overlay/src/shared/capture.ts` holds `CAPTURE_ALLOWED_TYPES` — the
default-deny allowlist gating what the "Report bug" capture ring retains
(see [overlay-main-process.md](overlay-main-process.md)). It's a module
(not inlined in `main/index.ts`) specifically so this test can import it.

Every packet-stream consumer exports a `CONSUMED_ENVELOPE_TYPES` const
listing the envelope types its `ingest`/`onPacketBatch` handler branches on:
`DpsTracker`, `LootTracker`, `EntityRegistry` (`sprites/EntityRegistry.tsx`),
and `ItemInfoProvider` (`items/ItemInfoProvider.tsx`). The test asserts each
is a subset of `CAPTURE_ALLOWED_TYPES`. This is what closes the #144/#146
failure class: a capture that can't contain a type a tracker actually needs
used to fail silently (a UI bug report with no visible root cause); now it's
a red test the moment the gap is introduced, not discovered four soaks later.

This test is why `CAPTURE_ALLOWED_TYPES` also lists `itemInfo` and
`enchantNames` (`ItemInfoProvider`'s two consumed types) — both small,
non-sensitive, asset-derived tables, the same category as the pre-existing
`objectNames`/`dps`/`lootBagTypes` entries; they were simply never added to
the allowlist before this tripwire existed to check for the gap.

## Capture buffer format (`shared/capture.ts`)

Also documented in [overlay-main-process.md](overlay-main-process.md)'s "The
'Report bug' capture ring" section — summary: ring capacity 10,000 envelopes
total, with per-type quotas for high-frequency types (`MovePacket` 500,
`NewTickPacket` 1,000, `UpdateAckPacket`/`GotoAckPacket` 300 each) so they
can't crowd out lower-frequency types and shrink the ring's wall-clock
coverage, everything else sharing the remaining headroom. `pushCapturePacket`
evicts oldest-of-that-type first when a push exceeds its quota, then
oldest-of-any-type if the overall cap is still exceeded. `reportBug`'s output
is compact (non-pretty-printed) JSON, gzipped — `realmshark-bug-<ts>.json.gz`.

## Out of scope (this issue)

- **CI wiring** (`ci.yml`'s `npm test` step) is a human/local follow-up —
  agents can't touch `.github/` (see root `CLAUDE.md`).
- **Java-side replay** (`CaptureReplay.java`, mirroring a capture's envelopes
  through `DpsEngine` directly) is PRD Phase 2/§6.5, a separate issue. Damage
  attribution bugs (e.g. #50) originate bridge-side; the TS replay harness
  here can only reproduce *display* of a `dps` envelope, not compute one —
  see `test/fixtures/captures/README.md`'s soak-50 entry for a concrete case
  where this matters.
- **The renderer screenshot/Playwright harness** (PRD Feature 1, "eyes") is a
  separate issue/phase; unrelated to this test suite.
