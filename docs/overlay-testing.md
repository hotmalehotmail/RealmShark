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

- **`loadCapture(filePath)`** - reads either a bug-report capture
  (`.json`/`.json.gz`, gzip detected by extension, falling back to
  magic-byte sniffing so a misnamed file still loads) - the full capture
  object `IPC.reportBug`/`IPC.captureNow` write (`{version, recentPackets,
  …}` - see `docs/overlay-main-process.md`'s capture-ring section) or a bare
  `PacketEnvelope[]` - or a session recording (`.ndjson`/`.ndjson.gz`, one
  `PacketEnvelope` JSON object per line - the format
  `SessionRecordingWriter`/`main/sessionRecorder.ts` writes, see
  `docs/overlay-main-process.md`'s Session recorder section), detected by
  extension. Either way, returns envelopes sorted by `time`.
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
detail. One (`soak-122-equip-unequip.json.gz`) is the real soak-#122
attachment issue #157 named (recovered by issue #160 once the sandboxed
egress block on `github.com/user-attachments/...` was lifted); the other two
(`soak-144-loot-empty.json.gz`, `soak-50-other-player-damage.json.gz`) stay
synthesized because their real attachments predate the envelope type
(`lootBagTypes`, `dps` respectively) each fixture's regression test needs, so
they cannot support the assertion without either fabricating that envelope on
top of unrelated real noise or downgrading the test to a smoke test - see the
fixtures README's per-fixture "Why still synthetic" notes. If a real capture
ever surfaces (or a fresh one is recorded, PRD §7.3) that does contain the
needed envelope, it can replace the matching fixture without touching the
tests - they assert on tracker *behavior*, not on capture bytes.

`session-recording-sample.ndjson.gz` demonstrates the fourth fixture source
below: a slice of a session recording, committed as-is.
`baseline-session.ndjson.gz` is the real thing at scale — the
maintainer-recorded **kitchen-sink seed corpus** (PRD §7.3/D5, 24k envelopes
from a live 2026-07-16 session): the standing reference for "what does X
really look like on the wire" (grep it before assuming), smoke-replayed and
fact-pinned by `baseline-session.test.ts`. See the fixtures README for its
coverage and known gaps (no dungeon/boss or white/orange drop yet — extend
the corpus with a future recording, don't edit the slice).

## Slicing a session recording into a fixture

The session recorder (Settings → "Record session to disk", PRD §7.2 - see
`docs/overlay-main-process.md`'s Session recorder section) writes rolling
`userData/captures/session-<timestamp>-<counter>.ndjson.gz` files: one
`PacketEnvelope` JSON object per line, gzip-compressed, allowlist-filtered
identically to the bug-report ring. Because it's line-delimited, cutting a
scenario out of a recording is a text operation, not a conversion step:

1. `gunzip` the file (or read it with any gzip-aware tool) to get plain NDJSON
   text - one envelope per line.
2. Select the lines spanning the scenario you want (by eyeballing `type`/`time`
   fields, or grepping for a marker envelope like `MapInfoPacket` /
   `CreateSuccessPacket`). Standard line tools work: `head`/`tail`/`sed`/`grep`,
   or a short script if the boundary needs `time`-range logic.
3. Write the selected lines back out, gzip them, and commit under
   `overlay/test/fixtures/captures/<slug>.ndjson.gz` (or `.ndjson`
   uncompressed, also supported).
4. `loadCapture()` reads it exactly like a `.json.gz` bug-report capture (see
   above) - no conversion, no reshaping. Write the regression test the same
   way as any other fixture (see "Writing a new regression test from a
   capture" below).

No in-app editor exists for this by design (PRD §7 out-of-scope) - slicing
NDJSON is already trivial with text tools, and an editor would be scope this
issue's `docs/prd-agent-observability.md` deliberately deferred.

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

**`TextPacket` (`AlertEngine`'s chat detector, issue #222) is a second, but
different, deliberate exemption.** Unlike `ItemInfoProvider`'s, this one is a
privacy floor, not a scope boundary: `docs/prd-notifications.md` §6 requires
`CAPTURE_ALLOWED_TYPES` to never cover chat (`TextPacket` includes DMs, and
captures/recordings go to public GitHub issues or a user's own disk), so
`AlertEngine.CONSUMED_ENVELOPE_TYPES` legitimately includes a type the
allowlist will never retain. `allowlist.test.ts` carries this as a named
`TEXT_PACKET_EXEMPTION` set (with its own assertion that `TextPacket` stays
out of `CAPTURE_ALLOWED_TYPES`) rather than silently widening the tripwire's
subset check - do not "fix" a future red test here by adding `TextPacket` to
the allowlist. The accepted cost: `partyChat` bugs can never be reproduced
from a user's bug-report capture or session recording, only from a synthetic
`FakePacketSource` fixture (its periodic chat cycle - see `CLAUDE.md`'s
"Local testing without Windows or the game" section and
`src/main/java/bridge/FakePacketSource.java`'s own class doc comment)
replayed through `AlertEngine` directly, e.g.
`overlay/test/alerts-engine.test.ts`'s "AlertEngine chat detector" suite and
`overlay/test/alerts-chatTypes.test.ts`.

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

## Java replay mirror

Damage attribution is computed bridge-side (`DpsBroadcaster` runs `DpsEngine`; the TS tracker
above only displays the precomputed `dps` envelope - see `docs/dps-engine.md`), so a TS-side
replay of an attribution bug reproduces the *display* of wrong data, not the bug itself. A JUnit
mirror of this same `loadCapture`/`replay` contract - `bridge/replay/CaptureReplay.java`,
`src/test/java` - feeds decoded packets through `Register` into `DpsBroadcaster`/`DpsEngine`
directly, so a bridge-side attribution bug (like #46, #98) is reproducible and
regression-testable headlessly. It reads the *same* committed fixtures this directory documents.
See `docs/dps-engine.md`'s "Capture replay (Java)" section for the envelope→`Packet`
reconstruction contract, the clock seam, and what each Java-side test fixture proves.

## Out of scope here (later phases)

- **Renderer screenshot harness**: visual bugs aren't covered by this vitest
  suite - see `docs/overlay-harness.md` for the separate browser harness +
  `npm run shots` pipeline that renders and screenshots every panel instead.
