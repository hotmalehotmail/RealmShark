# Capture fixtures

Gzipped bug-report captures (`IPC.reportBug`'s output shape - see
`overlay/src/main/index.ts`) that power the replay regression tests in
`overlay/test/*.test.ts`. Load with `loadCapture()` (`overlay/test/replay.ts`).

## Provenance

These three fixtures reproduce the three real soak failures issue #157 names
as ground truth (soak #144, #122, #50 - see the issue body for the original
`realmshark-bug-*.json` attachment URLs), but they are **synthesized, not the
literal historical attachments**: the build agent's sandboxed egress policy
blocks `github.com/user-attachments/...` (not a repo-scoped path, so the proxy
returns 403 - see the PR's Assumptions section), so the real files could not
be downloaded. Each fixture instead hand-builds the minimal envelope sequence
that reproduces the *mechanism* of the reported bug against the real
`PacketEnvelope` wire shapes (`packets/incoming/*.java` field names, `StatType`
numeric ids) documented in `docs/bridge-server.md` / the trackers' own
`types.ts` files - not a byte-for-byte replay of a specific live session. If a
real capture is ever recovered (or a fresh one recorded per PRD §7.3), it
should replace the matching synthetic fixture here; the regression tests
should keep passing unchanged since they assert on tracker *behavior*, not on
capture contents.

## Fixtures

### `soak-122-equip-unequip.json.gz`

**Reported bug:** equipping/unequipping the local player's own gear was
incorrectly counted as a loot drop (fixed in PR #124).

**Contents:** a `MapInfoPacket`, a `lootBagTypes` meta envelope, the local
player's `CreateSuccessPacket` + initial `UpdatePacket`, then two
`NewTickPacket` deltas that equip and unequip `INVENTORY_0` (statTypeNum 8) on
the player's own entity (objectType 782, not a registered loot-bag entity
type).

**What it supports:** `LootTracker` only watches loot-bag *entities*
(`UpdatePacket.newObjects` / `NewTickPacket` for an objectType present in
`lootBagObjectTypes`) - never a player's own equip slots - so this fixture
exercises that structural guarantee: replaying it produces **zero** loot
entries. `allowlist-regression.test.ts`'s second case appends one bag-entity
drop envelope on top of this same fixture in-test (a "mutated/synthesized
true-drop variant") and asserts exactly **one** entry appears, showing the
zero-entry result isn't just "nothing was ever ingested."

### `soak-144-loot-empty.json.gz`

**Reported bug:** the Loot panel stayed empty after a correct-BagType drop;
root cause was an empty `lootBagObjectTypes` table at the moment the bag
appeared (fixed in PR #146, which added the `pendingNewObjects` replay queue).

**Caveat (per the issue body):** the real #144 attachment was recorded
*before* PR #146 added `lootBagTypes` to `CAPTURE_ALLOWED_TYPES`, so even the
real file might not contain that envelope at all. This synthetic fixture
sidesteps that by construction: it deliberately orders a loot-bag
`UpdatePacket.newObjects` entry **before** the `lootBagTypes` envelope, the
exact race PR #146 fixed.

**What it supports:** replaying it asserts `LootTracker` recovers the queued
bag once `lootBagTypes` arrives late - exactly one entry, for the item that
arrived before metadata was available.

### `soak-50-other-player-damage.json.gz`

**Reported bug:** other players' damage was missing from the DPS list.

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
