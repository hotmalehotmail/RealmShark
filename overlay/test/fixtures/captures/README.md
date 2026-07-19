# Capture fixtures

Gzipped bug-report captures (`IPC.reportBug`/`IPC.captureNow`'s output shape -
see `overlay/src/main/index.ts`) or session recordings (`.ndjson`/`.ndjson.gz`
- `SessionRecordingWriter`/`overlay/src/main/sessionRecorder.ts`'s output
shape, PRD §7.2) that power the replay regression tests in
`overlay/test/*.test.ts`. Load either with `loadCapture()`
(`overlay/test/replay.ts`). See `docs/overlay-testing.md` for how to slice a
session recording into a committed `.ndjson.gz` fixture like
`session-recording-sample.ndjson.gz` below.

These fixtures also power the **Java** capture-replay harness
(`src/test/java/bridge/replay/CaptureReplay.java`, `docs/dps-engine.md`'s
"Capture replay (Java)" section) - the same files, read with a Java mirror of
`loadCapture()`, replayed through `DpsEngine` directly instead of the TS
trackers. Both harnesses read straight from this directory; there is no
separate Java-side fixture copy.

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
| `soak-237-loot-reenter.json.gz` | **Real** (soak #237, `0.22.4-alpha`, trimmed) | Self-contained: the regression only needs the same loot-bag entity's `newObjects`/`drops` cycle, which the real trace supports directly - trimmed from the full 10,000-envelope ring (see its own section below) purely for fixture size, not because the real data was insufficient. |

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

### `soak-237-loot-reenter.json.gz` (real, trimmed)

**Reported bug:** a ground bag's notification re-fires after the player walks
away and comes back (fixed in the soak-#237 fix-forward PR).

**Contents:** trimmed from the real 10,000-envelope soak-#237 bug-report
capture (attached to issue #237, downloaded via the redirect through
`objects.githubusercontent.com` - the direct `github.com/user-attachments/...`
URL is blocked by this environment's egress policy, same class of block issue
#160 previously hit and cleared with `WebFetch`'s automatic redirect
resolution). The real capture is a `0.22.4-alpha` live-game session: a single
`lootBagTypes` envelope (trimmed to the one relevant bag/item mapping - the
untrimmed envelope is ~700 KB of the full asset-facts dump, all real values,
just filtered down) plus the 10 real `UpdatePacket` envelopes for loot-bag
entity objectId 609 (a BagType-2 bag, entity objectType 1287, holding one
"Greater Magic Potion", objectType 2796, in its first slot): `newObjects` /
`drops` / `newObjects` / `drops` / ... five times over, the exact
walk-away-and-back cycle the report describes. Every field (objectIds, item
id, timestamps, stat values, the enchant code) is copied verbatim from the
real capture; only *which* envelopes and *which* keys of the `lootBagTypes`
maps were kept was trimmed.

**What it supports:** replaying it into a `LootTracker`/`AlertEngine`
reproduces the exact live-repro mechanism - the same bag objectId re-entering
view five times with no new item - so a regression back to clearing
`loggedBagSlots` on `drops` fails `alerts-replay.test.ts`'s soak-#237 case
(5 fired alerts instead of 1).

### `baseline-session.ndjson.gz` (real — the kitchen-sink seed corpus, PRD §7.3/D5)

**Not a soak fixture** - the maintainer-recorded seed corpus: a **verbatim**
~8-minute slice (24,094 envelopes, ~11 MB gzipped - the one deliberately
heavyweight fixture in this directory) of a real session recorded 2026-07-16
via Settings → "Record session to disk" on a live client. Its primary role is
**standing documentation of wire reality**: before assuming what any packet
"looks like," grep this file for the real thing (companion to the asset-facts
rule in CLAUDE.md - the same never-invent-facts discipline, for the wire).
`baseline-session.test.ts` smoke-replays it and pins the facts a guess would
most plausibly get wrong (e.g. `MapInfoPacket.displayName` arrives as the RAW
localization key `{s.nexus}` - the soak-#89 class of bug - while `.name`
carries the resolved string).

**Coverage** (see the test for the pinned details): heavy instance churn
(13 `MapInfoPacket`s - nexus/vault/Pet Yard hops, each with its
`CreateSuccessPacket`), a live multiplayer roster (300+ real `NAME_STAT`
names, committed as-is - maintainer decision, same posture as the soak
fixtures; usernames are public in-game), brown (1280) and soulbound (1283)
bag-entity drops, and real spam-type ratios (`UpdateAckPacket` ≈ 19%,
`UpdatePacket` ≈ 19%, `objectNames` ≈ 13%). **Known gaps**, to be filled by a
future recording session rather than by editing this one: no dungeon/boss
encounter (the sole `QuestObjectIdPacket` is `id=-1`), no realm event chain,
and no white/orange bag drop (tracked-color recognition stays covered by
`soak-144-loot-empty.json.gz`). **Newly discovered while building the Java
replay harness (issue #192):** all of this capture's own combat predates its
first `MapInfoPacket` - the recording started mid-fight, so the local
player's own object id never resolves to attributed damage from this file
alone (a bare JUnit replay also can't compute local self-damage at all - see
`docs/dps-engine.md`), and none of the 13 in-file, `CreateSuccessPacket`-
identified realm segments contain further combat. The Java side uses this
fixture only as a real-world-scale robustness/no-exceptions check
(`BaselineSessionReplayTest`); local-player attribution and the
recompute-vs-recorded comparison are proven on `replay-attribution.json.gz`
below instead, where every input is controlled.

### `replay-attribution.json.gz` (synthetic, Java-only)

**Not a soak fixture** - a small, hand-authored bug-report-shaped capture (issue #192) built
specifically for the Java replay harness's `ReplayAttributionTest`. Establishes a local player
(`CreateSuccessPacket` objectId 100) and another player (objectId 200), both using an
object type never classified as a player character (mirroring the real issue #46 capture, where
`assets/xml/players.xml` classification never succeeded for anyone), then attributes 50 damage
to the local player and 30 to the other player - both via `DamagePacket` rather than the local
weapon-reconstruction path (see `docs/dps-engine.md`'s "Capture replay (Java)" for why: a bare
JUnit replay has no extracted weapon asset data, so `Projectile`-based self-damage is always 0
regardless of fixture). Two `NewTickPacket`s drive the engine's fight-timer clock explicitly
(`DpsEngine.timePc` only advances on a `NewTickPacket`, unlike everything else in the engine
which takes a `timePc` parameter). Carries one recorded `dps` envelope with hand-verified exact
expected values (`fightMs`, `damage`, `dps` per player) - the fixture this repo's
recompute-vs-recorded assertion replays against, and the replacement for the old hand-transcribed
`DpsEngineOtherPlayerAttributionTest` (now removed - the same scenario, from a committed capture
instead of Java literals).

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

### `realm-boss-rollover.json.gz` (synthetic)

**Reported bug:** in the open-world Realm, killing a quest boss rolled its
whole damage total onto the *next* quest boss and snapped the DPS label to it
instantly, instead of resetting per boss. The real bug-report capture (a
10,000-envelope ring) is too large to commit and, crucially, starts *after*
the Realm's own `MapInfoPacket` (so a replay of it can't even establish Realm
context), so this scenario is reproduced by a small hand-authored fixture
against the real `PacketEnvelope` wire shapes instead.

**Contents (12 envelopes):** a Realm `MapInfoPacket` (`displayName`
`{s.rotmg}`, realm-score fields `>= 0`), a local player + another player + Boss
A ("Possessed Pumpkin"), a `QuestObjectIdPacket` locking Boss A, `DamagePacket`s
from both players onto Boss A, then the **kill/swap tick** — all sharing one
`time`, with Boss B's ("Legion Excavator") `QuestObjectIdPacket` ordered
**before** the `UpdatePacket.drops` that despawns Boss A (the exact same-tick
ordering the live capture showed) — then `DamagePacket`s onto Boss B.

**What it supports:** `dps-replay.test.ts`'s "Realm boss-swap rollover" cases.
One replays the fixture as-is and asserts the DPS panel does **not** carry Boss
A's damage onto Boss B (focus holds on the just-killed Boss A until Boss B is
hit, then shows only Boss B's own damage). The other clones the envelopes with
the `MapInfoPacket` swapped to a dungeon (no Realm signals) and asserts the
carry-forward path is **unchanged** there (a genuine multi-phase dungeon boss
still merges phases) - so the fix is proven to be Realm-scoped, not a blanket
removal of carry-forward. See `docs/overlay-renderer.md` §5 "Boss-phase damage
carryover".
