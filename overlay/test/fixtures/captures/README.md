# Capture fixtures

Gzipped bug-report captures (`IPC.reportBug`/`IPC.captureNow`'s output shape -
see `overlay/src/main/index.ts`) or session recordings (`.ndjson`/`.ndjson.gz`
- `SessionRecordingWriter`/`overlay/src/main/sessionRecorder.ts`'s output
shape, PRD §7.2) that power the replay regression tests in
`overlay/test/*.test.ts`. Load either with `loadCapture()`
(`overlay/test/replay.ts`). See `docs/overlay-testing.md` for how to slice a
session recording into a committed `.ndjson.gz` fixture like
`session-recording-sample.ndjson.gz` below.

## Provenance

Issue #157 named three real soak-failure attachments as ground truth (soak
#144, #122, #50). The build agent that implemented #157 (PR #158) could not
download them - its sandboxed egress policy blocked
`github.com/user-attachments/...` at the time - so all three fixtures were
originally **synthesized**: hand-built envelope sequences reproducing the
*mechanism* of each reported bug against the real `PacketEnvelope` wire shapes
(`packets/incoming/*.java` field names, `StatType` numeric ids), not
byte-for-byte replays of a specific live session.

That egress block was lifted (2026-07-14) and the real attachments were
recovered (already committed, undownloaded a second time, on the
closed-duplicate branch `claude/keen-euler-j7iw7v`, PR #159). Issue #160
tracks swapping the synthetic fixtures for the real ones where the real
capture can actually support the test it's meant to power - **each real
capture predates the 10,000-envelope/quota buffer upgrade (issue #157) and
caps out at the old 300-envelope ring**, so several are missing the exact
envelope(s) their regression test needs. Where that happens, this repo keeps
the synthetic fixture rather than downgrade the test to a smoke test - see
each entry below.

| Fixture | Status | Why |
|---|---|---|
| `soak-122-equip-unequip.json.gz` | **Real** (soak #122, `0.15.5-alpha`) | Self-contained: the regression only needs "no bag entity => no entries," which the real 300-envelope trace supports directly. |
| `soak-144-loot-empty.json.gz` | Synthetic | The real #144 capture (verified: 300 envelopes, zero `lootBagTypes`) predates PR #146 adding `lootBagTypes` to `CAPTURE_ALLOWED_TYPES` - it contains **no** `lootBagTypes` envelope at all, so it cannot exercise the metadata-arrives-late recovery race PR #146 fixed, which is exactly what this fixture's test asserts. |
| `soak-50-other-player-damage.json.gz` | Synthetic | The real #50 capture (verified: 300 envelopes, `UpdateAckPacket`/`ShowEffectPacket`/`PlayerShootPacket`-heavy) contains **no** `{type:"dps"}` envelope and no `DamagePacket`/`EnemyHitPacket` - the ring had rotated past whatever damage traffic triggered the report. `DpsTracker` only *displays* the bridge's precomputed `dps` envelope, so without one this fixture can only power a "doesn't throw" smoke test, not the multi-player-row assertion the #50 regression is about. Named `soak-50-other-player-damage.json.gz` (not the real branch's `soak-50-dps-attribution.json.gz`) since the fixture that ships here is the synthetic one, not that download. |

If a future issue records a fresh capture (PRD §7.3) or a `lootBagTypes`/`dps`
envelope-bearing real trace turns up for #144/#50, it can replace the
matching synthetic fixture without touching the tests - they assert on
tracker *behavior*, not on capture bytes.

## Fixtures

### `soak-122-equip-unequip.json.gz` (real)

**Reported bug:** equipping/unequipping the local player's own gear was
incorrectly counted as a loot drop (fixed in PR #124).

**Contents:** a real 300-envelope soak-#122 trace (`0.15.5-alpha`):
`UpdatePacket`/`UpdateAckPacket` (54 each), `MovePacket` (50), `NewTickPacket`
(49), `ShowEffectPacket` (48), `objectNames` (27), `NotificationPacket` (18).
No `CreateSuccessPacket` (the capture's ring had already rotated past it) and
no `lootBagTypes` envelope. The local player (objectType 782, objectId 78290)
appears via `UpdatePacket.newObjects` with `INVENTORY_0..3` (equipped-slot)
stats, matching the reported equip/unequip traffic; no loot-bag entity type
appears anywhere in `newObjects`.

**What it supports:** `LootTracker` only watches loot-bag *entities*
(`UpdatePacket.newObjects` / `NewTickPacket` for an objectType present in
`lootBagObjectTypes`) - never a player's own equip slots, and never anything
at all before a `lootBagTypes` envelope arrives - so replaying this trace
produces **zero** loot entries regardless of what the player's gear did.
`loot-replay.test.ts`'s second case layers a synthesized `lootBagTypes` +
bag-entity `UpdatePacket` on top of this same real session (the real capture
never received a `lootBagTypes` broadcast, so one has to be synthesized to
prove the zero-entry result isn't just "nothing was ever classified") and
asserts exactly **one** entry appears.

### `soak-144-loot-empty.json.gz` (synthetic)

**Reported bug:** the Loot panel stayed empty after a correct-BagType drop;
root cause was an empty `lootBagObjectTypes` table at the moment the bag
appeared (fixed in PR #146, which added the `pendingNewObjects` replay queue).

**Why still synthetic:** the real #144 attachment (recovered from
`claude/keen-euler-j7iw7v`, inspected: 300 envelopes, `0.17.1-alpha`) was
recorded *before* PR #146 added `lootBagTypes` to `CAPTURE_ALLOWED_TYPES`, so
it contains **zero** `lootBagTypes` envelopes across its whole ring - exactly
the caveat issue #157 flagged. Without a single `lootBagTypes` envelope ever
arriving, the real trace cannot exercise "recovers once metadata catches up"
at all; using it here would mean fabricating both the pre-metadata bag and
the metadata itself on top of unrelated real noise, which adds no fidelity
over the existing synthetic fixture while looking more "real" than it is.
Keeping the synthetic fixture per issue #160's explicit fallback.

**Contents:** a `MapInfoPacket`, a `lootBagTypes` meta envelope, the local
player's `CreateSuccessPacket` + initial `UpdatePacket`, then a bag-entity
`UpdatePacket.newObjects` entry that arrives **before** `lootBagTypes` (the
exact race PR #146 fixed).

**What it supports:** replaying it asserts `LootTracker` recovers the queued
bag once `lootBagTypes` arrives late - exactly one entry, for the item that
arrived before metadata was available.

### `soak-50-other-player-damage.json.gz` (synthetic)

**Reported bug:** other players' damage was missing from the DPS list.

**Why still synthetic:** the real #50 attachment (recovered from
`claude/keen-euler-j7iw7v`, inspected: 300 envelopes, `0.10.2-alpha`, mostly
`UpdateAckPacket` (210) with `ShowEffectPacket`/`PlayerShootPacket` (21 each))
contains **no** `{type:"dps"}` envelope and no `DamagePacket`/`EnemyHitPacket`
- the ring had rotated past whatever damage traffic triggered the report.
`DpsTracker` only *displays* the bridge's precomputed `dps` envelope (the
real bug is server-side Java attribution - see `docs/dps-engine.md`), so a
real trace with no `dps` envelope at all can only prove "doesn't throw," which
issue #160 explicitly forbids downgrading a test to. Keeping the synthetic
fixture, which already contains a correct multi-player `dps` breakdown, per
issue #160's explicit fallback.

**Caveat:** the real bug was server-side (Java `DpsEngine` attribution - see
`docs/dps-engine.md`); replaying a capture's `dps` envelope through the TS
tracker reproduces the *display* of whatever the bridge computed, not the
attribution bug itself (PRD §6.1/D4 - the Java replay mirror in a later phase
covers that). This fixture's `dps` envelope already contains a correct
multi-player breakdown (a non-local player's row alongside the local
player's).

**What it supports:** a regression guard on the TS side - `DpsTracker` must
surface every row the bridge sends, not just the local player's, for the
locked quest-objective target. Guards against a future regression that
filters or drops non-local rows in `ingestBridgeDps`/`snapshot`.

### `session-recording-sample.ndjson.gz` (synthetic, demonstrates the recorder format)

**Not a soak fixture** - a hand-built, session-recorder-shaped (NDJSON, one
envelope per line, gzipped) fixture demonstrating that `loadCapture()` reads
a session recording exactly like a `.json.gz` bug-report capture (issue
#174). Contents mirror `soak-144-loot-empty.json.gz`'s bag-before-metadata
scenario (`MapInfoPacket`, a bag `UpdatePacket` arriving before
`lootBagTypes`, then `lootBagTypes` itself) so `session-recorder-replay.test.ts`
can assert the same recovery behavior through this format. Future PRs that
slice a real recorded session (PRD §7.3's `baseline-session` or a per-issue
recording) should follow this fixture's naming/README pattern rather than
replace it - it specifically exists to guard the NDJSON code path, independent
of any particular real scenario.
