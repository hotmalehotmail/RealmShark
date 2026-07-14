# Capture fixtures

Real "Report bug" captures (`{version, platform, ..., recentPackets, mainLogs}`)
from past alpha-soak failures, committed gzipped and replayed by
`test/*.replay.test.ts` via `test/replay.ts`'s `loadCapture`/`replay`. See
[`docs/overlay-test-suite.md`](../../../docs/overlay-test-suite.md) for the
harness itself; this file documents what each fixture actually contains,
since a capture's usefulness is bounded by what was captured, not by the bug
it was originally attached to.

All three predate the 10,000-envelope/quota capture-buffer upgrade (issue
#157) - each one caps out at the old 300-envelope ring, which is why none of
them span very much wall-clock time.

## `soak-144-loot-empty.json.gz`

- **From:** alpha soak #144. **Reported bug:** the Loot panel stayed empty
  after a correct-bagtype drop. **Root cause:** the bridge's
  `lootBagObjectTypes` table was empty; fixed in PR #146.
- **Recorded:** `0.17.1-alpha`, 300 envelopes, mostly `UpdatePacket` (93) /
  `UpdateAckPacket` (93) / `objectNames` (90) with a handful of
  `NewTickPacket`/`MovePacket`/misc.
- **Does NOT contain a `{type:"lootBagTypes"}` envelope at all** - this
  capture was recorded *before* PR #146 added `lootBagTypes` to
  `CAPTURE_ALLOWED_TYPES`, exactly the caveat flagged in issue #157. Every
  `UpdatePacket.newObjects` entry in this trace is therefore permanently
  unclassifiable by `LootTracker` regardless of what real bag entities it
  does or doesn't contain - there's no way to tell from this file alone.
- **What it can test:** that today's (fixed) `LootTracker` reproduces this
  exact failure mode against this exact trace - zero loot entries, because
  the classification metadata never arrived. It can NOT test the positive
  case (a real drop being correctly detected); see the synthesized-variant
  test in `test/loot.replay.test.ts` for that.

## `soak-122-equip-unequip.json.gz`

- **From:** alpha soak #122. **Reported bug:** equipping/unequipping gear
  was incorrectly logged as a loot-bag drop. **Root cause:** the pre-fix
  `LootTracker` watched the local player's own inventory slots instead of
  loot-bag entities in the world, so a gear swap looked identical to a pickup;
  fixed in PR #124 by switching to bag-entity-based detection (see
  `LootTracker`'s class doc comment).
- **Recorded:** `0.15.5-alpha`, 300 envelopes: `UpdatePacket`/`UpdateAckPacket`
  (54 each), `MovePacket` (50), `NewTickPacket` (49), `ShowEffectPacket` (48),
  `objectNames` (27), `NotificationPacket` (18). No `CreateSuccessPacket` (the
  capture's ring had already rotated past it) and no loot-bag entity anywhere
  in `newObjects` - just a player object (objectType 782) picking up
  `INVENTORY_0..3` (equipped-slot) stat deltas.
- **What it can test:** that today's bag-entity-based `LootTracker` finds
  zero loot entries in this trace (the direct regression assertion for #124 -
  it has no bag entity to false-positive on). `test/loot.replay.test.ts` also
  appends a hand-synthesized `lootBagTypes` + bag-entity `UpdatePacket` (wire
  shapes lifted from `bridge/LootBagTypes.java` and
  `packets/data/enums/StatType.java`, not from a real capture - no committed
  fixture actually contains a real white/orange bag drop) to prove the
  zero-entries result is a true negative, not the tracker silently doing
  nothing.

## `soak-50-dps-attribution.json.gz`

- **From:** alpha soak #50. **Reported bug:** other players' damage was
  missing from the DPS list. **Root cause:** Java-side attribution in
  `bridge.dps.DpsEngine` (see PRD D4) - the TS `DpsTracker` only *displays*
  the bridge's precomputed `{type:"dps"}` envelopes, it doesn't compute
  attribution itself.
- **Recorded:** `0.10.2-alpha`, 300 envelopes, mostly `UpdateAckPacket` (210)
  with `ShowEffectPacket`/`PlayerShootPacket` (21 each), `MovePacket` (12),
  `NewTickPacket` (11), `UpdatePacket` (10), `ServerPlayerShootPacket` (5).
- **Contains no `{type:"dps"}` envelope and no `DamagePacket`/
  `EnemyHitPacket`** - the ring had rotated past whatever damage traffic
  triggered the bug report. Since the bug is in Java-side attribution and
  this trace has none of the inputs to that attribution, replaying it through
  the TS tracker cannot reproduce the reported misattribution either way.
- **What it can test:** a smoke test only - that `DpsTracker` replays real
  (if incomplete) traffic from that era without throwing and returns a
  well-formed snapshot. The real #50 regression needs the Phase 2 Java
  `CaptureReplay` mirror (PRD §6.5, issue tracked separately) replaying
  packets through `DpsEngine` directly - out of scope for this issue's
  TS-only replay harness.
