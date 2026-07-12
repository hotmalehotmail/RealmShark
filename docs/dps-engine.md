# DPS engine — how computed DPS works

The Java DPS engine (`src/main/java/bridge/dps/**`) is a port of the DPS-relevant
subset of the *tomato* project's `TomatoData`. It consumes the live packet stream
(fed by `bridge.DpsBroadcaster`, see [bridge-server.md](bridge-server.md)) and
maintains per-enemy, per-attacker damage totals that the overlay renders. Its
defining trait is in the name: a passive sniffer does **not** receive damage
numbers for the local player's own shots, so the engine **reconstructs** that
damage from weapon/projectile definitions, a seeded RNG, player stats, ability
scaling, and target defence. Everyone else's damage arrives as finished numbers
and is used almost verbatim. This doc traces that math and — importantly — flags
which parts of the ported code are actually wired vs. dormant.

## Files covered

| File | Role |
| --- | --- |
| `bridge/dps/DpsEngine.java` | Top-level state machine; one method per consumed packet; owns entity/projectile/attribution maps and the RNG. |
| `bridge/dps/Entity.java` | Per-object state (stats, damage lists); the hit-resolution + defence math (`userProjectileHit`, `genericDamageHit`). |
| `bridge/dps/Projectile.java` | A shot's reconstructed/base damage; the RNG damage-roll constructor and the `damageWithDefense` static. |
| `bridge/dps/Damage.java` | One recorded damage entry (owner, amount, metadata snapshot); aggregation via `add`. |
| `bridge/dps/Stat.java` | Thin `StatData[200]` indexed by stat-type number. |
| `bridge/dps/AbilityScalingManager.java` | Parses `equip.xml` for ability stat-scaling. **Dormant — `initialize()` is never called.** |
| `bridge/dps/ParseEnchants.java` | Loads `enchantments.xml`; decodes enchant strings; enchant multipliers. Only `getEnchantStrings` is on a live path. |
| `bridge/dps/CrucibleBonusManager.java` | Crucible damage multiplier. **Effectively inert — data is never loaded.** |
| `bridge/dps/CrucibleApiClient.java` | HTTP GET `api.realmshark.cc/crucible`. **Never called.** |
| `bridge/dps/PcStatsDecoder.java` | Six-bit (base64url) string → bytes; compressed-int decode. Only `sixBitStringToBytes` is used. |
| `bridge/dps/RealmCharacter.java` | Char-list XML model. **Dormant — never constructed.** |
| `bridge/dps/RealmCharacterStats.java` | PCStats blob decoder. **Dormant — never constructed.** |
| `bridge/dps/HttpCharListRequest.java` | HTTP POST to `realmofthemadgod.com` char/list. **Dormant — never called.** |
| `bridge/dps/SecurityAbilityUseCheck.java` | No-op stub (integration stand-in). |
| `bridge/dps/PlayerRemoved.java` | Snapshot of a player at the moment they left an enemy's damage list. |
| `bridge/dps/Version.java` | Gradle-populated version string (used only for the crucible User-Agent). |
| `bridge/dps/enums/CharacterClass.java` | Loads `players.xml`; the `isPlayerCharacter(objectType)` test used everywhere. |
| `bridge/dps/enums/CharacterStatistics.java` | Static table of PCStat bit-ids / dungeon sprite-ids / names. |
| `bridge/DpsBroadcaster.java` | (entry boundary) routes packets into the engine; builds the `{type:"dps"}` JSON snapshot. |

## The core problem — why DPS is "computed"

RealmShark is a passive packet sniffer. For **other** players and pets, the game
server broadcasts either the finished damage of a shot (`ServerPlayerShootPacket.damage`)
or a resolved `DamagePacket.damageAmount`. But the **local** client only tells the
server *which bullet hit which target* — it never transmits how much its own shots
did (the server trusts the client's `EnemyHitPacket`). So the local player's own
damage is absent from the wire and must be **reconstructed**:

> **Non-obvious fact.** The engine seeds a per-map RNG (`rng = new RNG(map.seed)`,
> `DpsEngine.java:90`) that mirrors the game client's deterministic bullet-damage
> roll. That is the whole reason a local weapon shot's damage can be recomputed to
> match what the game actually rolled — `Projectile`'s RNG constructor rolls the
> *same* value between the weapon's min/max as the client did.

The load-bearing comment lives in `Entity.userProjectileHit` (`Entity.java:233-238`):
*"The server sends final damage for other players' shots, so we must not
re-calculate those on the client."* Local shots go through the reconstruction path;
everything else is taken as given.

## Entry boundary & inputs

`DpsBroadcaster.feed(Packet)` (`bridge/DpsBroadcaster.java:48-79`) is the only way
in. It is a `synchronized(engine)` type-switch; a `Throwable` guard ensures an
engine bug can never stall packet capture. It returns whether the packet was a
damage event (`EnemyHitPacket`/`DamagePacket`), which `PacketBridge` uses to
push a DPS snapshot promptly instead of waiting for the periodic cadence — see
`bridge-server.md`. Consumed packets:

| Packet (direction) | Engine method | Contribution |
| --- | --- | --- |
| `MapInfoPacket` (in) | `setNewRealm` | `clear()` all state, then seed `rng` from `map.seed`. Instance boundary. |
| `CreateSuccessPacket` (in) | `setUserId` | Sets `worldPlayerId` + `charId` (the authoritative local-player id). Sent once, at map load. |
| `UpdatePacket` (in) | `update` | Adds/updates entities from `newObjects`; processes `drops` (despawn, minion cleanup, player-drop bookkeeping). |
| `NewTickPacket` (in) | `updateNewTick` | Sets server time; applies stat deltas per object (`status[i]`). |
| `PlayerShootPacket` (out) | `playerShoot` | **Local** shot → reconstruct a `Projectile` via RNG. |
| `ServerPlayerShootPacket` (in) | `serverPlayerShoot` | Any other entity's/pet's shot → `Projectile` carrying the server's `damage`; records minion→owner. |
| `EnemyHitPacket` (out) | `enemtyHit` | **Local** hit landed → look up the reconstructed projectile, apply scaling+defence, record damage. |
| `DamagePacket` (in) | `damage` | Resolved damage event → record `damageAmount` as-is. |

Note the direction column: the two **outgoing** packets (`PlayerShoot`,
`EnemyHit`) are emitted only by the local machine — that is what makes them the
local-player signal. `CrucibleResponsePacket` exists in the protocol but is **not**
routed here (see Crucible, below).

### Resolving the local ("world") player

Two sources set `worldPlayerId`:

1. `CreateSuccessPacket` → `setUserId` (`DpsEngine.java:100-106`). Authoritative, but
   sent only once at map load — **missed on a mid-instance attach**.
2. `EnemyHitPacket.mainID` → `resolveLocalPlayer` (`DpsEngine.java:119-135`), invoked
   at the top of every `enemtyHit`. `mainID` is the local player and arrives on
   every hit, so it re-establishes identity continuously.

`resolveLocalPlayer` points `player` at the already-existing `Entity` in
`entityList` (created from NewTick/Update stats) and calls `e.setUser(charId)`.

> **Non-obvious fact.** Without (2), a sniffer that attaches after map load would
> leave `player == null`, and *every self-shot projectile would compute 0 damage*
> — self-DPS would silently never appear. The renderer's tracker mirrors this
> exact dual-source logic (`DpsTracker.ingestEnemyHit`).

## The scaling stack — how one local shot becomes damage

```
PlayerShootPacket (weaponId, projectileId, bulletId)
        │  DpsEngine.playerShoot
        ▼
new Projectile(rng, player, weaponId, projectileId)          Projectile.java:48
        │  IdToAsset min/max/armorPierce/slotType   (assets/xml → asset-pipeline.md)
        │  dmg = min + rng.next() % (max-min)                  :81-86   (seeded roll)
        │  + AbilityScalingManager stat bonus  [ability only]  :92-101  (dormant*)
        │  × player.playerStatsMultiplier()    [main weapon]   :107-109
        ▼
stored in playerProjectiles keyed (player.id<<32)|bulletId    DpsEngine.java:294-296
        │
        ▼  (later)  EnemyHitPacket (bulletId, targetId, mainID) → DpsEngine.enemtyHit
projectile looked up by (shooterID<<32)|bulletId              DpsEngine.java:457-459
        ▼  Entity.userProjectileHit
   + proc stat-scaling if containerType has scaling (dormant*) Entity.java:296-357
   − Projectile.damageWithDefense(dmg, ap, targetDef, conds)   Entity.java:361-390
        ▼
   new Damage(attacker, projectile, timePc, dmg) → addPlayerDmg  Entity.java:393-396
```
`*` The ability/proc stat-scaling steps depend on `AbilityScalingManager`, which is
never initialized in the bridge (see below), so at runtime they contribute 0.

### Projectile base damage & the stat multiplier

`Projectile(RNG, Entity, weaponId, projectileId)` (`Projectile.java:48-111`):

- Reads `min/max/armorPierces/slotType` from `IdToAsset` (extracted game data).
- Rolls `dmg = min + (rng.next() % (max-min))` when `min != max` (`:81-86`).
- For **ability** projectiles (not a main weapon per `isMainWeapon`, `:113-124`),
  adds `AbilityScalingManager.calculateStatBonus(...)`.
- For **main weapons**, multiplies by `player.playerStatsMultiplier()` (`:107-109`).

`Entity.playerStatsMultiplier()` (`Entity.java:179-203`) is the RotMG attack
formula: `(attack + 25) * 0.02`, ×1.25 when the *Damaging* condition is set, ×0.5
when *Weak*, then `× crucibleMultiplier` (local player only) and `× exaltDmgBonus`
(`EXALTATION_BONUS_DAMAGE / 1000`).

### Defence reduction

`Projectile.damageWithDefense` (`Projectile.java:161-192`) is applied to the local
shot at the moment of hit. Armour-pierce (or the pierce condition) zeroes defence;
Armoured ×1.5; Exposed −20. Final `dmg = max(damage*2/20, damage − defence)`, then
condition tweaks (invuln → 0, Petrify ×0.9, Curse ×1.25). The floor `damage*2/20`
(= 10%) means a hit never does less than a tenth of its rolled damage.

### AbilityScalingManager — DORMANT

`AbilityScalingManager` parses `assets/xml/equip.xml` in `initialize()`
(`AbilityScalingManager.java:72-97`) into `scalingData` (weaponId →
`{scalingStat, scalingMin, damagePerStat, numShots}`). `calculateStatBonus`
(`:399-421`) returns `(statValue − scalingMin) × damagePerStat × statDamageMultiplier`.

> **Non-obvious fact / discrepancy.** `initialize()` is **never called anywhere**
> in the codebase (verified: the only references are `getInstance()` calls in the
> dps package). So `scalingData` is always empty → `hasScaling()` always false,
> `getScalingData()` always null, `calculateStatBonus()` always 0. Ability
> stat-scaling — and the enchant `statDamageMult` it would pull via
> `getStatDamageMultiplier` (`:423-444`) — is inert in the bridge as wired today.
> All the `serverPlayerShoot`/`Damage` code that snapshots a "scaling stat"
> (`DpsEngine.java:369-389`, `Damage.java:61-83`) runs but finds no scaling data.

### ParseEnchants

`ParseEnchants` static-loads `assets/xml/enchantments.xml`
(`ParseEnchants.java:50-53`) into name/effect/regen/loot maps. It decodes the
per-item enchant blob (six-bit → bytes, type `1026`, shorts terminated by `-3`;
`-2`=locked, `-1`=empty). Of its large API, only two entry points are reached on a
live path:

- `getEnchantStrings(Entity)` (`:258-270`) — splits `UNIQUE_DATA_STRING` by comma
  into 4 raw slot strings (weapon/ability/armor/ring). Called by `Damage.setInv`
  (`Damage.java:224`) purely as **metadata** on each recorded hit (`ownerEnchants`).
- `getStatDamageMultiplier(code)` — called only from the dormant scaling path.

> **Non-obvious fact.** The weapon damage/rate multipliers (`computeWeaponMultipliers`,
> `getMin/MaxDamageMultiplier`, ...) are **not applied** to the reconstructed shot —
> `Projectile`'s RNG constructor never calls them. Enchant damage bonuses therefore
> do not affect computed DPS today; the multiplier helpers, plus all the mana/life
> regen and loot-bonus methods, have no live caller. They are ported scaffolding.

### CrucibleBonusManager + CrucibleApiClient — DORMANT

`Entity.playerStatsMultiplier` multiplies in
`CrucibleBonusManager.getPlayerDamageMultiplier()` for the local player
(`Entity.java:196-200`). That method (`CrucibleBonusManager.java:168-173`) multiplies
the stored multipliers for the player's crucible ids from stats 128 & 155.

But the three methods that would *populate* that state —
`processCrucibleResponse`, `fetchCrucibleDataFromApi`, and `updatePlayerCrucibleBonus`
— have **no callers**. `CrucibleApiClient.fetchCrucibleData()` (a real HTTP GET to
`https://api.realmshark.cc/crucible`, `CrucibleApiClient.java:16-79`) is likewise
never invoked. So `crucibleDamageMultipliers` stays empty and the current-id fields
stay null → `getPlayerDamageMultiplier()` **always returns 1.0**. Crucible bonus is
a no-op in practice; the only external HTTP the engine *could* make is unreachable
as wired.

### Damage attribution & minions

`DpsEngine` tracks minion/pet ownership so summoned damage lands under the player:

- `serverPlayerShoot` records `minionOwnerMap[ownerId] = summonerId` when a shot has
  a summoner (`DpsEngine.java:333-335`).
- On a hit, `enemtyHit` redirects `shooterId` to `projectile.getSummonerId()` when
  set (`:481-483`); `damage` looks the attacker up in `playerList`, else falls back
  to `entityList` and remaps via `minionOwnerMap` (`damage`, `:530-553`). Damage from
  an entity with no known player owner is dropped rather than shown as `NO_NAME`.

Recorded hits accrue on the **target** `Entity`: `addPlayerDmg` (`Entity.java:437-447`)
appends to `damageList` and merges into a per-owner `damagePlayer` map (this is what
`getPlayerDamageList()` sorts). Boss-phase flags (Oryx 3 guard, Forgotten King
reflectors, Chancellor Dammah) are set in `bossPhaseDamage` and only affect the
"counter damage" accounting, not the totals (`Entity.java:495-511`, `Damage.addCounters`).

> **Non-obvious fact / discrepancy.** Despite the name, `bossPhaseDamage`
> (`Entity.java:495-511`) does **not** aggregate a boss's damage across phase/objectId
> changes - it only flags three specific counter-damage mechanics. A boss changing
> form gets a brand new `objectId`, hence a brand new `Entity` in `entityList` with a
> damage total starting at zero; the engine has no notion of "this new id is the same
> encounter as that old id." The renderer's `DpsTracker` is what carries a boss's
> total across a phase transition (via `QuestObjectIdPacket` - see
> [overlay-renderer.md](overlay-renderer.md) §5) - entirely client-side, no change here.

## Character-stat decoding

- `Stat` (`Stat.java`) is a `StatData[200]` indexed by `statTypeNum`; `get(StatType)`
  / `get(int)` are the accessors the whole engine uses. Populated from every
  Update/NewTick via `Entity.updateStats` → `stat.setStats`.
- `Entity.calculateBaseStats` (`Entity.java:578-607`) derives the 8 base stats
  (HP/MP/ATK/DEF/SPD/DEX/VIT/WIS) by subtracting each `*_BOOST_STAT` from its total.
- `PcStatsDecoder.sixBitStringToBytes` (`PcStatsDecoder.java:47-78`) is the base64url
  variant decoder used by `ParseEnchants` (and `RealmCharacterStats`). Its other
  methods — `decodePsStats` / `readCompressedInt` — have **no callers**.

### RealmCharacter / RealmCharacterStats / HttpCharListRequest — DORMANT

These three are a self-contained, **unwired** cluster (a straight carry-over from
tomato's account/char-list feature):

- `HttpCharListRequest` (`char/list`, `account/listPowerUpStats` HTTP POSTs) — no caller.
- `RealmCharacter.getCharList(xml)` parses the char-list XML into models — never invoked.
- `RealmCharacterStats.decode(pcStats)` unpacks the PCStats bitfield blob (a 16-byte
  presence bitmap + compressed ints) using `CharacterStatistics` bit-ids — only ever
  reached from `RealmCharacter`, which is itself dormant.

They compile and self-reference but contribute nothing to the DPS snapshot. Treat
them as reference/future-use code, not part of the live path.

### SecurityAbilityUseCheck & PlayerRemoved

- `SecurityAbilityUseCheck` (`SecurityAbilityUseCheck.java:14-25`) is a **no-op stub**.
  Its two methods (`checkManaFromStasis`, `checkManaFromDecoyUsed`) are called from
  `Entity.updateStats` (`Entity.java:84-86`) with real signatures so the port
  compiles; the actual mana-from-ability security heuristics were GUI-coupled and dropped.
- `PlayerRemoved` (`PlayerRemoved.java`) is a small immutable snapshot (id, hp, max,
  name, time) recorded by `Entity.addPlayerDrop` when a player leaves an enemy's
  damage list — used for "players remaining at kill" accounting, not DPS totals.

## Enums

**`CharacterClass`** (`enums/CharacterClass.java`) loads `assets/xml/players.xml` in a
static block into per-class stat/weapon-group data. Its single hot method is
`isPlayerCharacter(objectType)` (`:188-190`), which `DpsEngine.isPlayerEntity`
(`DpsEngine.java:245-247`) and `Entity.name()` use to decide whether an object is a
player (and thus goes into `playerList` and is named from `NAME_STAT`).

**`CharacterStatistics`** (`enums/CharacterStatistics.java`) is a static table mapping
each stat/dungeon to a `pcStatId` (the bit index in the PCStats blob) and a
`spriteId` (the dungeon's object type). It only feeds `RealmCharacterStats` decoding,
so — like that class — it is dormant on the DPS path.

## Output — the DPS snapshot

`DpsBroadcaster.snapshotJson()` (`bridge/DpsBroadcaster.java:78-117`) walks
`engine.getEntityHitList()` (every enemy that has taken tracked damage) and, per
enemy, emits `getPlayerDamageList()` (per-attacker cumulative totals, sorted
descending). Wire shape (`type:"dps"`, `direction:"internal"`):

```
{ type:"dps", time, data:{ enemies:[
    { id, name, fightMs, players:[ { id, name, damage, dps }, ... ] }
] } }
```

> **Non-obvious fact — cumulative, not a rolling window.** `damage` is the enemy's
> whole-fight running total for that player, and `dps = damage / fightSec` where
> `fightSec = getFightTimer()/1000 = (lastDamageTaken − firstDamageTaken)/1000`
> (`DpsBroadcaster.java:91-105`). So the Java path reports **average DPS over the
> entire fight so far**. Contrast the renderer's own 8-second rolling window below.

Also note `p.name` is the bridge's best guess (falls back to `IdToAsset.objectName`
= class name when a player lacks `NAME_STAT`); the renderer overrides it with the
`NAME_STAT` username it saw in the stream.

## Two DPS paths — Java engine vs. renderer tracker

There are **two** DPS computations, and the UI uses **both** with a clear priority.
The renderer's `DpsTracker` (`overlay/src/renderer/src/dps/DpsTracker.ts`) ingests
the packet stream itself *and* the bridge's `{type:"dps"}` envelope:

- `ingestBridgeDps` (`DpsTracker.ts:169-192`) indexes the Java engine's computed
  snapshot by enemy id.
- `ingestDamage` (`:228-257`) also builds its **own** estimate from raw
  `DamagePacket`s into an 8-second rolling window (`WINDOW_MS = 8000`, `:13`).

In `snapshot()` (`:291-337`) it **prefers the bridge's computed DPS** for the focused
enemy when present — precisely because that path includes the local player's own
reconstructed damage, which the renderer's packet-only estimate cannot see — and
**falls back** to its own rolling-window numbers otherwise. It always uses its own
`entityNames`/`objectNames` maps for display names and its own focus target — sticky
on the game's quest objective (`QuestObjectIdPacket`) when one is active, falling
back to `EnemyHitPacket`/`DamagePacket` last-hit otherwise; see `overlay-renderer.md`
§5. Both feed the same `DpsPanel`.

So: **the Java engine's snapshot is authoritative and primary; the renderer tracker
is a self-damage-blind fallback plus the naming/focus layer.** For the internals of
that tracker, see [overlay-renderer.md](overlay-renderer.md) — not duplicated here.

## Wiring status at a glance

| Component | Live on the DPS path? |
| --- | --- |
| Local-shot reconstruction (`playerShoot`→`enemtyHit`→`userProjectileHit`) | Yes |
| Base weapon RNG roll + `playerStatsMultiplier` (attack/exalt/weak/damaging) | Yes |
| `damageWithDefense` (defence + conditions) | Yes |
| Other-player / pet damage via `DamagePacket` + minion attribution | Yes |
| `getEnchantStrings` (metadata on `Damage`) | Yes |
| `AbilityScalingManager` (ability/proc stat scaling) | **No — `initialize()` never called** |
| Enchant damage/rate multipliers, regen, loot bonus | **No — no live caller** |
| `CrucibleBonusManager` / `CrucibleApiClient` (multiplier + HTTP) | **No — data never loaded; returns 1.0** |
| `RealmCharacter` / `RealmCharacterStats` / `HttpCharListRequest` | **No — never constructed/called** |
| `SecurityAbilityUseCheck` | No — no-op stub |

## Code-vs-summary discrepancies (verify before trusting)

- **CLAUDE.md / types.ts claim the engine does "weapon/ability/crucible" math.** The
  code does weapon (RNG + attack/exalt) math and defence, but **ability scaling and
  crucible are dormant** as wired (`AbilityScalingManager.initialize()` and every
  crucible-load method are un-called). Damage that depends on ability stat-scaling or
  a crucible multiplier is currently under-counted / unmodified. Re-check these before
  relying on them.
- **Enchant damage bonuses are not applied** to reconstructed damage at all — only the
  raw enchant strings are attached as metadata.
- **HttpCharListRequest is not "unwired but present" trivia — it is one of several fully
  dormant classes** (`RealmCharacter`, `RealmCharacterStats`, char-list HTTP). The DPS
  engine memory note that "char-list HTTP is unwired" is correct and extends to the
  whole char-list/PCStats cluster.

## Cross-references

- [bridge-server.md](bridge-server.md) — how `DpsBroadcaster.feed` is driven and the
  snapshot is flushed over the WebSocket.
- [asset-pipeline.md](asset-pipeline.md) — `IdToAsset` / `assets/xml/*.xml`
  (`equip.xml`, `enchantments.xml`, `players.xml`) that the engine reads.
- [overlay-renderer.md](overlay-renderer.md) — the renderer `DpsTracker` and DPS panel.
- [architecture.md](architecture.md) — where the engine sits in the overall system.
</content>
</invoke>
