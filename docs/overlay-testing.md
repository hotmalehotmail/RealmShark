# Overlay test suite & capture replay

The overlay's vitest suite (`overlay/test/`) turns a live-game bug capture
into a permanent, executable regression test - closing the gap the PRD
identifies (`docs/prd-agent-observability.md` §6): the "repro capture" a bug
report promises was, until this suite existed, not consumed by anything. Read
this before adding a test, writing a new packet-stream consumer, or fixing a
bug that ships with a capture.

## Running it

```bash
cd overlay
npm test              # vitest run
```

`vitest.config.ts` mirrors `electron.vite.config.ts`'s `@renderer` alias
(`tsconfig.web.json`'s path) and includes the React plugin - not because tests
render components, but because importing a `.tsx` provider module (e.g.
`EntityRegistry.tsx`, for its `CONSUMED_ENVELOPE_TYPES` export) requires its
JSX to be transformed even when nothing in the test tree calls `render()`.
Tests run under vitest's plain `node` environment (no `jsdom`) - the trackers
under test (`DpsTracker`, `LootTracker`) are framework-agnostic classes, not
components.

## The core fact that makes replay nearly free

`DpsTracker.ingest(packets: PacketEnvelope[])` and
`LootTracker.ingest(packets: PacketEnvelope[])` (`overlay/src/renderer/src/
dps/DpsTracker.ts`, `.../loot/LootTracker.ts`) consume **exactly** the array
shape a bug capture's `recentPackets` field holds - the same shape
`IPC.packetBatch` delivers live. A capture is therefore already a fixture; no
transcription step exists between "what a user attached to an issue" and
"what a test can feed a tracker."

## `overlay/test/replay.ts`

- **`loadCapture(filePath)`** - reads a `.json` or `.json.gz` file (gzip
  detected by extension, falling back to magic-byte sniffing so a misnamed
  file still loads), accepting either the full capture object `IPC.reportBug`
  writes (`{version, recentPackets, …}` - see `docs/overlay-main-process.md`'s
  capture-ring section) or a bare `PacketEnvelope[]`. Returns envelopes sorted
  by `time`.
- **`replay(trackers, envelopes, opts?)`** - feeds envelopes into one or more
  `Ingestable`s (anything with `ingest(packets: PacketEnvelope[])`) using
  **vitest fake timers anchored to each envelope's own `time`**
  (`vi.useFakeTimers()` + `vi.setSystemTime(envelope.time)` before every
  ingest). This is load-bearing, not an optimization: `DpsTracker.ts`
  (`bossChainEntry`'s `Date.now()`, `retainInstanceIfQualifying`) and
  `LootTracker.ts` (`droppedAt: Date.now()`) compare envelope data against
  wall-clock time, so replaying a week-old capture with the real clock running
  would read every rolling window as already-expired and assert nothing (PRD
  D3). Anchoring the fake clock to the capture's own timeline makes replay
  behave exactly as it did live. The caller owns `vi.useRealTimers()` teardown
  (an `afterEach` in every test file below).
- **`replayUntil(trackers, envelopes, untilMs)`** - `replay` with a `time`
  cutoff, for asserting a *transient* mid-fight/mid-drop state rather than the
  capture's final one. Pass a fresh tracker instance per call - re-running
  `replay`/`replayUntil` against a tracker that already ingested part of the
  same envelope list double-ingests those envelopes (trackers accumulate
  state, e.g. `DpsTracker`'s per-attacker damage buffers), so it isn't a
  resumable cursor.

## Fixtures (`overlay/test/fixtures/captures/`)

Gzipped captures + a `README.md` describing each one's scenario and exactly
what it does and doesn't cover - see that README for the full per-fixture
detail, including a documented provenance caveat: the three fixtures were
synthesized from the real wire-format shapes rather than downloaded from the
GitHub issue attachments issue #157 named, because the build agent's
sandboxed egress policy blocks `github.com/user-attachments/...` (not a
repo-scoped path). If a real capture is later recovered or freshly recorded
(PRD §7.3), it can replace the matching fixture without touching the tests -
they assert on tracker *behavior*, not on capture bytes.

## The allowlist tripwire (`overlay/test/allowlist.test.ts`)

`overlay/src/shared/capture.ts`'s `CAPTURE_ALLOWED_TYPES` is a default-deny
list of packet types retained in the bug-report capture ring (see
`docs/overlay-main-process.md`). The #144/#146 failure class (PRD §1) was a
tracker quietly starting to depend on an envelope type the allowlist didn't
retain - every capture for that scenario was then silently useless until
someone noticed by hand.

Each gameplay/behavior consumer exports a `CONSUMED_ENVELOPE_TYPES` const
that's meant to list exactly what its `ingest()`/`onPacketBatch` switch
handles: `DpsTracker.CONSUMED_ENVELOPE_TYPES`, `LootTracker.CONSUMED_ENVELOPE_TYPES`,
`EntityRegistry.CONSUMED_ENVELOPE_TYPES`. The tripwire test asserts the union
of these is a subset of `CAPTURE_ALLOWED_TYPES` - so adding a new envelope
type to a tracker's switch *and* remembering to append it to that tracker's
`CONSUMED_ENVELOPE_TYPES` fails a test if the allowlist isn't extended too,
instead of shipping a silently-useless capture.

**Caveat:** `CONSUMED_ENVELOPE_TYPES` is a hand-maintained list, not actually
derived from the switch (each switch has a `NOTE:` comment calling this out) -
so the tripwire only catches a missing allowlist entry for a type the author
*also remembered* to add to this list. A switch case added without touching
`CONSUMED_ENVELOPE_TYPES` passes the tripwire silently, reproducing the same
"forgot to update a parallel list" shape one level up. Deriving the list
programmatically from the switch would close this gap fully but wasn't done
here to avoid restructuring working, untested-elsewhere control flow as part
of a test-suite issue; worth revisiting if this class of miss recurs.

`ItemInfoProvider.CONSUMED_ENVELOPE_TYPES` (`itemInfo`/`enchantNames`) exists
for the same documentation purpose but is **deliberately excluded** from the
tripwire assertion: those are asset-derived display metadata, not currently
in `CAPTURE_ALLOWED_TYPES`, and this issue's allowlist is explicitly frozen
(its contents don't change here - see the PRD's out-of-scope list). Extending
the allowlist to cover them, if ever needed, is a separate deliberate change,
not a silent gap this suite should paper over.

## Writing a new regression test from a capture

The contract every future bug-fix PR that ships with a repro capture should
follow (see also `CLAUDE.md`'s FIX MODE instructions):

1. Commit the capture under `overlay/test/fixtures/captures/<slug>.json.gz`
   and add an entry to that directory's `README.md`.
2. Write a **failing** test first: `loadCapture()` the fixture, `replay()` it
   into the relevant tracker(s), and assert the behavior the bug report
   describes (e.g. "no loot entry appears" / "the enemy's damage total
   includes every player").
3. Fix the tracker until the test passes. The fixture and test ship in the
   same PR as the fix - see `overlay/test/loot-replay.test.ts` and
   `overlay/test/dps-replay.test.ts` for worked examples.

## Out of scope here (later phases)

- **Java replay mirror** (PRD §6.5): damage attribution is computed
  bridge-side (`DpsBroadcaster` runs `DpsEngine`; the TS tracker only displays
  the precomputed `dps` envelope - see `docs/dps-engine.md`), so a TS-side
  replay of an attribution bug reproduces the *display* of wrong data, not the
  bug itself. A `CaptureReplay.java` mirror that feeds decoded packets through
  `DpsEngine` directly is a separate, later issue.
- **Renderer screenshot harness** (PRD §5, Phase 2 issue): visual bugs aren't
  covered by this suite at all.
- **Capture-now button / session recorder** (PRD §7, Phase 3 issue).
