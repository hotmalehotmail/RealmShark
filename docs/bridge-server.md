# The Java WebSocket bridge — how the server works

The **bridge** is the Java process that turns RealmShark's decoded packet stream
into a stream of JSON the overlay can consume. It subscribes to every decoded
`Packet`, serializes each one to a `{type,direction,time,data}` envelope, and
broadcasts them in batches over a **loopback-only** WebSocket on
`127.0.0.1:47474`. Alongside the raw packets it also emits six *synthetic*
envelope kinds the overlay needs but the game never sends: `objectNames`
(enemy id→name), `dps` (server-computed damage), `lootBagTypes` (BagType 6/8
item categorization for the Loot panel), `itemInfo` (name/tier/class/
description/damage per objectType, for the item tooltip - issue #109),
`enchantNames` (enchant id→name, also for the item tooltip), and `spritePack`
(the atlas bundle). Capture runs on the sniffer thread; everything client-facing runs on a
single scheduled flusher thread, and a bounded drop-oldest queue sits between
them so a slow or dead client can never stall packet capture.

This doc covers the *server plumbing*. The DPS math lives in
[dps-engine.md](dps-engine.md); the sprite-pack contents live in
[asset-pipeline.md](asset-pipeline.md) and [dyes-and-textiles.md](dyes-and-textiles.md);
the canonical catalog of every wire envelope shape lives in
[architecture.md](architecture.md); the overlay client/supervisor that consumes
this is [overlay-main-process.md](overlay-main-process.md).

## Files covered

| File | Role |
| --- | --- |
| `src/main/java/bridge/PacketBridge.java` | Composition root + `main`. Wires everything, owns the queue and the scheduled flushers. |
| `src/main/java/bridge/BridgeServer.java` | The Java-WebSocket server: loopback bind, hello frame, broadcast, message routing. |
| `src/main/java/bridge/PacketSerializer.java` | `Packet` → JSON envelope via Gson (the wire-format contract). |
| `src/main/java/bridge/ObjectNames.java` | Loads enemy/NPC name assets; emits the synthetic `objectNames` envelope. |
| `src/main/java/bridge/DpsBroadcaster.java` | Thin adapter between the packet stream and the DPS engine; emits `dps` snapshots. |
| `src/main/java/bridge/LootBagTypes.java` | Resolves BagType 6/8 item categorization from asset data; emits the synthetic `lootBagTypes` envelope. |
| `src/main/java/bridge/ItemInfo.java` | Resolves item metadata (name/tier/class/description/damage) from asset data; emits the synthetic `itemInfo` envelope (issue #109). |
| `src/main/java/bridge/EnchantNames.java` | Resolves enchant id→name from `ParseEnchants.ENCHANTS`; emits the synthetic `enchantNames` envelope (issue #109). |
| `src/main/java/bridge/FakePacketSource.java` | `--fake` dev mode: synthetic traffic through the real `Register` pipeline. |

Out of scope (own docs): `bridge/dps/**` → [dps-engine.md](dps-engine.md);
`bridge/sprites/SpritePackService` internals → [asset-pipeline.md](asset-pipeline.md).

## Data & thread flow

```
  sniffer thread (or fake thread)                 flusher thread (single, daemon)
  ───────────────────────────────                 ───────────────────────────────
  Register.registerAll(lambda)                     every 33ms  ── flush() ─────────┐
    ├─ serializer.toJson(packet) ──enqueue──┐      every 250ms ── dps.snapshotJson─┤
    ├─ if UpdatePacket:                      │      every 3s   ── log debugState    │
    │    objectNames.envelopeFor ──enqueue──►│      every 2s   ── maybeBroadcast    │
    └─ dps.feed(packet)                      │        SpritePack (one-shot)         │
                                              │      every 2s   ── maybeBroadcast    │
                                              ▼        LootBagTypes (repeats)        │
                              LinkedBlockingQueue<String>(5000)                     │
                              drop-oldest on overflow                              ▼
                                                                    BridgeServer.send()
                                                                    = broadcast to all clients
                                                                              │
                                                                    ws://127.0.0.1:47474
```

The queue is the thread boundary. Capture only ever *enqueues* (non-blocking);
the flusher thread is the only writer to the socket.

> **Non-obvious fact.** The DPS engine (`dps.feed`) runs *inline on the sniffer
> thread*, not off the queue. Only the JSON strings go through the queue; the
> engine sees every packet synchronously (guarded by `synchronized(engine)` on
> the `DpsBroadcaster` side). See [dps-engine.md](dps-engine.md).

---

## 1. `PacketBridge` — the composition root

`PacketBridge` constructs and owns every collaborator (`PacketBridge.java:44-49`):

- `BridgeServer server` (the WebSocket server),
- `PacketSerializer serializer`,
- `ObjectNames objectNames`,
- `DpsBroadcaster dps`,
- `SpritePackService sprites`,
- `LootBagTypes lootBagTypes`,
- `BlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY)`.

The constructor also registers the inbound message handler:
`server.setMessageHandler(this::handleClientMessage)` (`PacketBridge.java:57`).

### Constants (read them here, not from memory)

| Constant | Value | Meaning | Ref |
| --- | --- | --- | --- |
| `DEFAULT_PORT` | `47474` | listen port unless `--port` overrides | `PacketBridge.java:38` |
| `QUEUE_CAPACITY` | `5000` | bounded queue; drop-oldest guard | `PacketBridge.java:39` |
| `FLUSH_INTERVAL_MS` | `33` | batch flush cadence (~30/sec) | `PacketBridge.java:40` |
| `DPS_INTERVAL_MS` | `250` | DPS heartbeat cadence (sent when nothing's dirty) | `PacketBridge.java:41` |
| `DPS_COALESCE_MS` | `50` | poll/coalesce gap for damage-triggered DPS snapshots | `PacketBridge.java:42` |

### The `registerAll` subscription

`start(fake)` subscribes one lambda to *every* decoded packet
(`PacketBridge.java:106-116`):

```java
Register.INSTANCE.registerAll(packet -> {
    enqueue(serializer.toJson(packet));
    if (packet instanceof UpdatePacket) {
        String names = objectNames.envelopeFor((UpdatePacket) packet);
        if (names != null) enqueue(names);
    }
    if (dps.feed(packet)) dpsDirty = true;
});
```

`dps.feed` returns whether the packet was a damage event (`EnemyHitPacket` /
`DamagePacket`); setting `dpsDirty` here is what lets the DPS scheduler below
push a snapshot promptly instead of waiting for its heartbeat.

`registerAll` installs the listener under the `Packet.class` key
(`packets/packetcapture/register/Register.java:66-68`), so it fires for *all*
packet classes. The same subscription serves both the real sniffer and
`--fake` mode, because both drive `Register` (the sniffer via `PacketProcessor`,
the fake source via `Register.INSTANCE.emitPacketLogs`, which dispatches to the
`Packet.class` listeners — `Register.java:35-38`).

So each `UpdatePacket` produces **two** enqueued messages: the packet envelope,
then a synthetic `objectNames` envelope (when any new object resolves to a name).

### The bounded, drop-oldest queue

`enqueue` never blocks and never throws (`PacketBridge.java:189-194`):

```java
private void enqueue(String json) {
    if (!queue.offer(json)) {   // full?
        queue.poll();           // drop the oldest
        queue.offer(json);      // make room for the newest
    }
}
```

`offer` on a full `LinkedBlockingQueue` returns `false` (rather than blocking),
so on overflow the bridge drops the **oldest** queued message and keeps the
newest. This is the guarantee that packet capture can never be back-pressured by
a stuck client — the overlay is a nicety; capture is not.

### `flush` — batching

Every flush drains the whole queue into one `{"batch":[...]}` message
(`PacketBridge.java:197-210`). Each drained item is already a complete JSON
object, so the batch is assembled by string concatenation (not re-serialized).
Empty queue → no message. One WebSocket frame per flush (not per packet) keeps
frame counts low during dungeon bursts and lines up with a UI render frame.

> **Non-obvious fact.** A batch can interleave packet envelopes, `objectNames`,
> and `dps` envelopes — anything enqueued in the interval. Consumers must switch
> on each element's `type`, not assume a batch is homogeneous.

### The scheduled flushers

All seven periodic jobs run on **one** single-thread daemon scheduler named
`bridge-flusher` (`PacketBridge.java:122-177`):

| Job | Cadence | What it does | Ref |
| --- | --- | --- | --- |
| `flush()` | 33 ms | drain queue → broadcast one `{"batch":[…]}` | `:127` |
| DPS snapshot | polls every 50 ms; sends on damage or a 250 ms heartbeat | `dps.snapshotJson()`, enqueue if non-null | `:134-142` |
| engine diagnostic | 3000 ms | `System.out.println("[dps-engine] " + dps.debugState())` | `:146-148` |
| sprite-pack readiness | 2000 ms | `maybeBroadcastSpritePack()` (one-shot) | `:154-155` |
| loot BagType readiness | 2000 ms | `maybeBroadcastLootBagTypes()` (repeats every poll once ready) | `:164-165` |
| item-info readiness | 2000 ms | `maybeBroadcastItemInfo()` (repeats every poll once ready, issue #109) | `:169-170` |
| enchant-name table | 2000 ms | `enqueue(enchantNames.envelopeJson())` (repeats every poll, no readiness gate needed) | `:176-177` |

The DPS snapshot is *enqueued*, so it flows out with the next 33 ms flush like
any other message. The diagnostic writes to stdout only (it surfaces in the
overlay's Console panel; it is **not** sent to clients).

> **DPS snapshot cadence — coalesced, not fixed.** The scheduler runs every
> `DPS_COALESCE_MS` (50 ms, `:42`) but only enqueues a snapshot when `dpsDirty`
> is set (a damage packet landed since the last send) or the `DPS_INTERVAL_MS`
> heartbeat (250 ms, `:41`) has elapsed (`:134-142`). So a hit gets a snapshot
> out within ~50 ms, a quiet fight still gets one every 250 ms, and a burst of
> hits within one 50 ms tick is coalesced into a single send.

`maybeBroadcastSpritePack` (`PacketBridge.java:175-186`) exists because assets
extract/load on a background thread (see `ObjectNames.init` below) and usually
aren't ready when a client first connects. It polls `sprites.ready()`; once
ready it **broadcasts** the full pack to every client exactly once
(`spritePackSent` latch) so clients that got an early not-ready reply still get
real sprites. Until then it logs the not-ready diagnostic up to 6 times.

### CLI args & startup order

`main` parses two flags (`PacketBridge.java:80-96`):

- `--port <n>` — override the listen port (`Integer.parseInt(args[++i])`).
- `--fake` — emit synthetic packets instead of sniffing.

Unknown args print a warning and are ignored. `start(fake)` then runs in order
(`PacketBridge.java:98-165`):

1. `objectNames.init(fake)` — kick off background asset load.
2. `Register.INSTANCE.registerAll(...)` — subscribe.
3. `server.start()` — start the WebSocket server (its own thread).
4. schedule the five flusher jobs.
5. start the packet source: `new FakePacketSource().start()` if `--fake`, else
   `new PacketProcessor().start()` (the real Npcap sniffer).

### Client-message handling

`handleClientMessage` (`PacketBridge.java:65-78`) is the only inbound path.
It parses the message as JSON, ignores anything that isn't a JSON object or
whose `type` isn't `"spritePackRequest"`, reads the optional `haveVersion`
string, and replies **directly to the requesting connection**:

```java
conn.send(sprites.responseFor(have));
```

`SpritePackService.responseFor` returns one of three shapes
(`bridge/sprites/SpritePackService.java:71-81`): a not-ready frame
(`{"type":"spritePack","ready":false}`), a tiny up-to-date ack when the client's
`haveVersion` matches the current version, or the full multi-MB pack. What's in
that pack (atlases, `table`, `maskTable`, `dyeTable`, `animTable`) is documented in
[asset-pipeline.md](asset-pipeline.md) and [dyes-and-textiles.md](dyes-and-textiles.md).
Parse failures are caught and logged, never propagated.

---

## 2. `BridgeServer` — the WebSocket server

`BridgeServer extends WebSocketServer` (the Java-WebSocket library). It is bound
to **loopback only** so sniffed game data never leaves the machine:

```java
super(new InetSocketAddress("127.0.0.1", port));   // BridgeServer.java:31
setReuseAddr(true);                                 // BridgeServer.java:32
```

Two wire constants identify the service (`BridgeServer.java:19-21`):
`SERVICE = "realmshark-bridge"` and `PROTOCOL_VERSION = 1` (bumped only on
breaking envelope/handshake changes).

### The hello frame

On every connection, `onOpen` sends a hello frame *first thing*, before any
packet data (`BridgeServer.java:46-52`):

```json
{"type":"hello","service":"realmshark-bridge","protocol":1}
```

This lets the overlay client confirm it reached the real bridge and a compatible
protocol rather than some other listener squatting on 47474 (the overlay's
`bridgeClient` validates it — see [overlay-main-process.md](overlay-main-process.md)).

### Message routing, broadcast, lifecycle

- `onMessage` delegates to the injected `MessageHandler` (a functional interface,
  `BridgeServer.java:24-26`) if one is set, else drops the message
  (`:60-66`). Clients are broadcast-only *except* for the routed request/response
  messages (today, just the sprite-pack fetch).
- `send(String)` is a thin alias for the library's `broadcast(...)` — it sends
  to **every** connected client (`BridgeServer.java:78-80`). There is no
  per-client filtering/subscription yet (phase-1 clients are receive-only).
- `onStart`/`onOpen`/`onClose`/`onError` all just log to stdout/stderr
  (`:41-71`). `onError` logs and does not tear down the server.

**Thread model.** The library runs its own selector/worker threads; `onOpen`,
`onMessage`, `onClose`, `onError` execute on those threads, *not* the flusher
thread. Broadcasts triggered from the flusher thread (`flush`,
`maybeBroadcastSpritePack`) and a direct reply from `handleClientMessage` (on a
selector thread) can therefore run concurrently — Java-WebSocket's `broadcast`
and per-conn `send` are safe to call from any thread.

---

## 3. `PacketSerializer` — the wire-format contract

`toJson(packet)` wraps each packet in an `Envelope` and Gson-serializes it
(`PacketSerializer.java:52-59`):

| Field | Value | Source |
| --- | --- | --- |
| `type` | `packet.getClass().getSimpleName()` (e.g. `"DamagePacket"`) | `:54` |
| `direction` | `"incoming"` / `"outgoing"` / `"unknown"` | `:61-65` |
| `time` | `System.currentTimeMillis()` | `:56` |
| `data` | the packet object itself | `:57` |

`direction` is resolved from `PacketType.byClass(packet)` and a set of incoming
indices built once at construction from
`PacketType.getPacketTypeByDirection(true)` (`PacketSerializer.java:43,61-65`;
`getPacketTypeByDirection` in `packets/PacketType.java:278-286`). A packet whose
class isn't in the `PacketType` map serializes as `"unknown"`.

### The `data` sub-object is raw reflection

Gson serializes `data` (the `Packet` subclass) by **reflecting its public field
names verbatim** — there are no custom `TypeAdapter`s for packet data. So
`DamagePacket`'s `targetId`, `damageAmount`, `bulletId`, `objectId`
(`packets/incoming/DamagePacket.java:15-35`) appear on the wire under exactly
those names. Enums serialize as their **name string** (Gson default), e.g. a
`StatData.statType` becomes `"NAME_STAT"`.

Two kinds of field are excluded. First, the raw payload: the base class carries
`private byte[] data` (`packets/Packet.java:12`) — Gson reflects private fields,
so an `ExclusionStrategy` explicitly drops it. Second, **login/device credentials**
— `HelloPacket`'s `accessToken`/`platformToken`/`clientToken`/`userToken` (and
`password`) — which have no UI or repro value and must never reach a client:

```java
public boolean shouldSkipField(FieldAttributes f) {
    if (f.getDeclaringClass() == Packet.class && "data".equals(f.getName())) return true;
    return SENSITIVE_FIELDS.contains(f.getName()); // accessToken, platformToken, …
}
```

The raw-payload rule keys on `declaringClass == Packet.class` (a subclass field
named `data` would still serialize); the credential rule keys on the field **name**
(matched on any class, so a future packet reusing one of those names is covered).

> **Bug-report privacy (defense in depth).** Credential *fields* are stripped
> here so they never reach the wire. Separately, the overlay's "Report bug"
> capture — attached to public issues — retains only an **allowlist** of gameplay
> packet *types* (`overlay/src/main/index.ts`, `CAPTURE_ALLOWED_TYPES`), so whole
> sensitive types (chat/`TextPacket`, account lists, `HelloPacket`) never enter a
> shared dump even though they still flow to the live overlay.

> **Wire-format gotcha.** Because the `data` object is a direct reflection of
> Java field names, any TypeScript consumer must match the Java class's public
> fields **exactly**, including nested data classes (which reflect their own
> fields the same way) and enum name strings. The source of truth is the Java
> source, not the observed wire output: read `src/main/java/packets/incoming/*.java`
> and `src/main/java/packets/data/*.java` before writing a new consumer. The
> full catalog of envelope shapes is in [architecture.md](architecture.md).

---

## 4. `ObjectNames` — synthetic enemy names

Enemies/NPCs carry no `NAME_STAT`, so the overlay would only know them by raw
object id. `ObjectNames` closes that gap by resolving `objectType → display name`
from the extracted game assets and shipping an id→name map.

### `init(fake)` — background, best-effort asset load

`init` spawns a daemon thread named `asset-loader` (`ObjectNames.java:41-60`):

- **real mode** (`fake == false`): first attempts a headless asset extraction
  from the installed game client, `AssetExtractor.extractHeadless("bridge")`,
  then `IdToAsset.reloadAssets()`.
- **fake mode** (`fake == true`): **skips extraction** and only calls
  `IdToAsset.reloadAssets()`, reading whatever `assets/ObjectID.list` already
  exists on disk (the synthetic list used for local testing).

Every step is wrapped in `try/catch(Throwable)`: a missing game, no assets, or a
headless environment simply leaves names unresolved (overlay falls back to the
id). It must never block or crash the bridge. This is the background load that
`maybeBroadcastSpritePack` waits on.

### `envelopeFor(UpdatePacket)` — the synthetic envelope

For each `UpdatePacket`, `envelopeFor` (`ObjectNames.java:69-85`) walks
`p.newObjects` (only *newly appeared* objects, so it's naturally deduplicated and
cheap — `packets/incoming/UpdatePacket.java:31-34`), skips objects that carry a
`NAME_STAT` (those are players, named client-side — `hasNameStat`,
`:87-93`), looks up `IdToAsset.objectName(obj.objectType)`, and collects
`objectId → name` for every resolved id. If nothing resolves it returns `null`
(and the caller enqueues nothing).

The emitted envelope deliberately mirrors `PacketSerializer`'s shape so the
overlay treats it uniformly (`ObjectNames.java:95-101`):

```json
{"type":"objectNames","direction":"internal","time":1720…,"data":{"100000":"Zombie"}}
```

`direction` is the sentinel `"internal"` (this envelope is bridge-synthesized,
not a real network packet); `data` is a plain `{ objectId(string): name }` map.

---

## 5. `DpsBroadcaster` — the DPS engine boundary

`DpsBroadcaster` is the thin adapter between the packet stream and the ported
`DpsEngine`. **The damage computation itself is documented in
[dps-engine.md](dps-engine.md)** — here we only cover the boundary.

- **`feed(Packet)`** (`DpsBroadcaster.java:43-70`) is called inline from the
  `registerAll` lambda on the capture thread. It dispatches by packet type to
  the matching engine method (`MapInfoPacket→setNewRealm`,
  `CreateSuccessPacket→setUserId`, `UpdatePacket→update`, `NewTickPacket→
  updateNewTick`, `PlayerShootPacket→playerShoot`, `ServerPlayerShootPacket→
  serverPlayerShoot`, `EnemyHitPacket→enemtyHit`, `DamagePacket→damage`); other
  types are ignored. The whole body is wrapped in `try/catch(Throwable)` so a bug
  in the ported engine can never stall capture (set env `DPS_TRACE` for a
  stacktrace, `:68`).
- **`snapshotJson()`** (`DpsBroadcaster.java:78-117`) builds the `dps` envelope:
  for each enemy the local user has hit (`engine.getEntityHitList()`), it lists
  each attacking player's total `damage` and average `dps`, where
  `dps = damage / (fightMs/1000)` — a **cumulative average over the whole
  fight timer**, not a rolling window. Returns `null` when there's nothing to
  report (so nothing is enqueued). Pet/minion damage is already attributed to
  the owning player by the engine.
- **`debugState()`** (`:36-40`) returns the engine's one-line state for the 3 s
  diagnostic log.

All three access the engine under `synchronized(engine)` (`:37,45,85`), because
`feed` runs on the capture thread while `snapshotJson`/`debugState` run on the
flusher thread.

The emitted envelope (`DpsBroadcaster.java:121-144`) again mirrors the packet
envelope with `type:"dps"`, `direction:"internal"`:

```json
{"type":"dps","direction":"internal","time":…,
 "data":{"enemies":[
   {"id":123,"name":"Zombie","fightMs":8200,
    "players":[{"id":1,"name":"Alice","damage":40320,"dps":4917.0}]}]}}
```

> **Note.** This server-side `dps` snapshot coexists with the overlay renderer's
> own `DpsTracker` (an 8 s rolling window computed client-side). They are two
> independent DPS computations over the same packet stream — see
> [overlay-renderer.md](overlay-renderer.md). Don't conflate them.

---

## 6. `LootBagTypes` — synthetic loot categorization

`LootBagTypes` resolves which item ids are BagType 6 (white bag) / 8
(orange/ST bag) — the two categories the overlay's Loot panel tracks (issue
#105) — from the same `IdToAsset` data `ObjectNames` reads, so the panel needs
no hand-maintained item list. Full field semantics (what `bagType` means, how
`Class=Bag` entities self-identify a color's icon) are in
[asset-pipeline.md](asset-pipeline.md); this section only covers the bridge
plumbing.

- **`ready()`** — `IdToAsset.loadedObjectCount() > 1`. Deliberately **not**
  gated on the sprite pack's atlas-readiness (`SpritePackService.ready()`,
  which also requires `characters.png` on disk): this data is pure asset
  metadata, no atlas needed, so it can become available - and get broadcast -
  well before (or entirely without) the full sprite pack ever does. This
  matters for `--fake` mode specifically: `FakePacketSource` registers a
  handful of synthetic `IdToAsset` entries via `IdToAsset.registerFake(...)`
  (bypassing real extraction, which needs a game install), which is enough to
  satisfy `ready()` and demonstrate the Loot panel with no game or atlas at
  all - see §7 below.
- **`envelopeJson()`** — walks `IdToAsset.objectIds()` once, keeping ids whose
  `getBagType(id)` is 6 or 8. A `Class=Bag` **entity** among them goes into
  `lootBagObjectTypes` (bag entity id → BagType — the set the overlay's drop
  tracker watches for, covering regular *and* boosted variants per color);
  every other such id is an item, added to `bagTypeTable` (item id → BagType) +
  `itemNames` (item id → `IdToAsset.objectName`). Separately,
  `IdToAsset.findBagIconObjectType(bagType)` resolves each tracked BagType's one
  representative `Class=Bag` entity id into `lootBagIcons` (the panel's category
  header sprite) — **and** (soak #144) is also folded into `lootBagObjectTypes`
  for that color, since the XML scan above finds no `Class=Bag`+own-`BagType`
  match at all on real assets (soak #113) and `lootBagObjectTypes` would
  otherwise stay permanently empty on a real client, with no drop ever
  recognized. Cached and only rebuilt when `IdToAsset.loadedObjectCount()`
  changes (a reload), so repeated polling is cheap.
- **Envelope shape** mirrors `ObjectNames`'s (`type:"lootBagTypes"`,
  `direction:"internal"`) - see the full JSON shape in
  [architecture.md](architecture.md#4f-lootbagtypes-envelope-inside-a-batch--synthetic-re-sent-periodically).

**Re-sent every poll, not one-shot.** `PacketBridge.maybeBroadcastLootBagTypes`
(`PacketBridge.java:167-176`) enqueues the envelope on **every** 2 s tick once
`ready()`, unlike the sprite pack's single `spritePackSent` latch. The payload
is tiny (two small id maps), so the simplest way to guarantee a client that
connects *after* the first broadcast still receives it is to keep sending it,
rather than adding a second on-demand request/response message alongside
`spritePackRequest`.

---

## 7. `FakePacketSource` — `--fake` dev mode

`FakePacketSource` lets you run the whole bridge (and overlay) with **no game and
no Npcap**, by emitting synthetic packets through the *same* `Register` pipeline
the real sniffer uses (`Register.INSTANCE.emitPacketLogs(...)`), so nothing
downstream can tell the difference. It runs on a daemon thread
`fake-packet-source` (`FakePacketSource.java:110-114`). Launch it with
`./gradlew runBridge -Pargs="--fake"` — see [build-and-release.md](build-and-release.md).

### Simulated entities (constants, `FakePacketSource.java:49-104`)

| Thing | Value | Purpose |
| --- | --- | --- |
| Roster ids | `{1,2,3,4}` | four fake players Alice/Bob/Carol/Dave — Bob and Dave's `NAME_STAT` carries a comma-appended title code (`"Bob,a0ca"`) to exercise client-side stripping |
| Local player | `id 1` (Alice) | "you" |
| Enemy ids | `{100000,100001}` | two distinct DPS targets |
| Enemy types | `{1900,1901}` | objectTypes → resolved to names via `IdToAsset` |
| Pet id | `50` | a summon owned by the local player (minion attribution) |
| Weapon id | `4000` | what the local player "fires" (needs projectile damage in assets); also Alice's INVENTORY_0 |
| Skin id | `2500` | local player's equipped skin (Character panel) |
| Roster equipment | per-player INVENTORY_0..3 (`ROSTER_EQUIPMENT`, `:80-85`) | every roster member has a full loadout, not just the local player |
| Weapon swap | id `2` (Bob), cycles `{4001,4010,4020,4030}` | a non-local player's INVENTORY_0 changes every ~10 ticks, exercising other-players' equipment updates |
| Transient player | id `5`, `"Eve,7f2c"` | joins then leaves on a 24-tick cycle, exercising roster removal via `UpdatePacket.drops` |
| `FAKE_NO_CREATE_SUCCESS` env | flag | simulate a mid-session attach (no `CreateSuccessPacket`) |
| Bag icon ids | `9000` (white), `9001` (orange) | synthetic `Class=Bag` entries (`IdToAsset.registerFake`), the Loot panel's category-header sprites |
| Loot item ids | `{9100,9100,9200,9300}` → BagTypes `{6,6,8,3}` | synthetic items registered the same way; `9100` repeats (exercises duplicate-pickup display), `9300` is untracked (must never appear in the Loot panel) |

### The emit loop (`FakePacketSource.java:116-184`)

Before the loop: emit a `MapInfoPacket` (seeds the engine RNG the damage roll
needs) and, unless `SKIP_CREATE_SUCCESS`, a `CreateSuccessPacket`. Then every
**300 ms tick**:

| When | Packets emitted | Why |
| --- | --- | --- |
| `tick % 15 == 0` | `rosterUpdate`, `enemyUpdate`, `petOwnership` | periodic resend so a late-connecting client still gets entity data within seconds |
| `tick > 0 && tick % 40 == 0` | `mapInfo`, `createSuccess`, `rosterUpdate`, `enemyUpdate`, `petOwnership` | fake **instance reset** — exercises the DPS tracker's reset-on-`MapInfoPacket`, immediately followed by a fresh entity burst |
| `tick % 24 == 6` | `transientJoin()` | a 5th player ("Eve") joins the instance |
| `tick % 24 == 18` | `transientLeave()` | "Eve" leaves the instance (`UpdatePacket.drops`), exercising roster removal |
| every tick | `newTick(tick)` | advancing server clock (`tickTime=300`, `serverRealTimeMS=tick*300`) — the engine's time base; without it every DPS is 0 |
| `tick > 0 && tick % 10 == 0` | `newTick(tick).status` carries `weaponSwapStatus(tick)` | cycles Bob's INVENTORY_0, exercising a non-local player's equipment updating live |
| every 16 ticks (`lootPickupStatus`) | `newTick(tick).status` carries a local-player bag-slot (INVENTORY_4..11) clear then set | simulates a loot pickup landing in a free bag slot - cycles all 8 slots and the 4 demo items, exercising the Loot panel's white/orange categorization and its untracked-item exclusion |
| every tick | `localPlayerShoot(bulletId)` + `localPlayerHit(target,bulletId)` | the self-DPS path: outgoing `PlayerShootPacket` (weapon) matched by `EnemyHitPacket` (same `bulletId`); `EnemyHitPacket.mainID` also identifies the local player |
| every tick | `randomDamage()` | a `DamagePacket` (50–499 dmg) attributed to a random roster member, or ~1-in-5 to the pet |

`bulletId = tick % 100`; the focus target switches every ~20 ticks
(`ENEMY_IDS[(tick/20) % 2]`) to exercise focus-switching.

### What each builder produces

- **`rosterUpdate`** (`:252-276`) — an `UpdatePacket` with four `ObjectData`,
  each `objectType = 0x0300` (768, the synthetic player class). Every roster
  member gets `playerStats` (a full maxed base+boost stat block + `NAME_STAT` +
  `EXALTATION_BONUS_DAMAGE` + that player's own `ROSTER_EQUIPMENT` slots, so the
  engine can compute a maxed player's damage and the Instance panel can render
  every player's loadout, `:340-364`). The local player additionally gets
  `localPlayerStats` (+ `SKIN_ID`, and `TEX1_STAT=4149`/`TEX2_STAT=4967` dye
  stats so the Character panel and dye compositing are exercised, `:372-385`;
  see [dyes-and-textiles.md](dyes-and-textiles.md)).
- **`weaponSwapStatus`** (`:283-291`) — a `NewTickPacket.status` entry cycling
  `SWAP_PLAYER_ID` (Bob)'s `INVENTORY_0`, so a non-local player's equipment
  updates render live too.
- **`transientJoin`** / **`transientLeave`** (`:294-311` / `:314-322`) — an
  `UpdatePacket` adding a 5th player ("Eve"), then dropping her via `drops`, to
  exercise roster removal.
- **`enemyUpdate`** (`:402-422`) — an `UpdatePacket` with two `ObjectData`
  carrying `ENEMY_TYPES` and `enemyStats` but **no** `NAME_STAT`, exactly like a
  real monster, so `ObjectNames` names them from their type.
- **`createSuccess`** (`:187-193`) — assigns the local-player identity
  (`objectId=1, charId=1`).
- **`localPlayerHit`** (`:200-209`) — outgoing `EnemyHitPacket` with
  `shooterID=mainID=1`, `targetId=enemy`.
- **`localPlayerShoot`** (`:212-225`) — outgoing `PlayerShootPacket` with
  `weaponId=4000`.
- **`petOwnership`** (`:239-249`) — a `ServerPlayerShootPacket` establishing
  `ownerId=50` as a summon whose `summonerId=1` (the local player).
- **`mapInfo`** (`:425-435`) — increments an internal counter and names the realm
  `FakeRealm<N>`; each one is a fresh instance.
- **`randomDamage`** (`:442-454`) — a `DamagePacket` toward a random enemy, from a
  random roster member or (rng 1-in-5) the pet.
- **`lootPickupStatus`** / **`lootSlotStat`** — every `LOOT_CYCLE_TICKS` (16)
  ticks, clears then populates the local player's next bag slot
  (INVENTORY_4..11, cycling through all 8) with the next demo item, an
  explicit empty-then-filled pair since the Loot panel only treats that
  transition as "obtained." Registered up front in `start()` via
  `IdToAsset.registerFake` (see §6) so the categorization data exists with no
  game installed.

Together these exercise per-enemy DPS tracking, local-player focus-target
attribution, minion attribution, the object-name resolver, the Character panel,
dye compositing, per-player equipment (including non-local updates and NAME_STAT
title-code stripping), roster join/leave, periodic instance resets, and the
Loot panel's asset-derived BagType categorization — the full surface without a
game.

---

## 8. `ItemInfo` / `EnchantNames` — the item tooltip's data (issue #109)

Two small synthetic tables feeding the overlay's item hover tooltip
(`ItemSprite` - see [overlay-renderer.md](overlay-renderer.md)): item metadata
per objectType, and enchant id→name resolution. Both follow `LootBagTypes`'s
shape and broadcast pattern (§6) rather than `ObjectNames`'s or the sprite
pack's.

- **`ItemInfo`** (`src/main/java/bridge/ItemInfo.java`) - `ready()` is the same
  `IdToAsset.loadedObjectCount() > 1` check as `LootBagTypes`. `envelopeJson()`
  walks every loaded object id and builds five id→value tables: `names`
  (`IdToAsset.objectName`), `tiers` (`IdToAsset.getTier`, new - see
  [asset-pipeline.md](asset-pipeline.md)), `classes` (`IdToAsset.getClazz`),
  `descriptions` (`IdToAsset.getDescription`, new), and `minDamage`/`maxDamage`
  (`IdToAsset.getIdProjectileMinDmg`/`MaxDmg(id, 0)`, only for ids that have
  projectile data at all - `IdToAsset.getIdProjectileCount(id) > 0`, a new
  bounds-safe query added alongside a fix to the projectile getters, which
  previously threw `ArrayIndexOutOfBoundsException` for any non-weapon object
  since every object gets a zero-length `Projectile[]`, not `null`). Cached
  and rebuilt on the same `loadedObjectCount()`-changed condition as
  `LootBagTypes`. Envelope: `type:"itemInfo"`, `direction:"internal"`.
- **`EnchantNames`** (`src/main/java/bridge/EnchantNames.java`) - reflects
  `bridge.dps.ParseEnchants.ENCHANTS` (enchant id→display name, loaded from
  `assets/xml/enchantments.xml` - see [dps-engine.md](dps-engine.md)) into
  `{"type":"enchantNames","data":{"names":{...}}}`. `ParseEnchants`'s static
  initializer reads the XML file synchronously the first time the class is
  referenced - which, on a real (non-`--fake`) machine, can be this class's
  own first broadcast (2s after bridge startup), well before `ObjectNames`'s
  background `AssetExtractor.extractHeadless` call has finished writing that
  file. Soak testing (issue soak #113) showed that race losing in practice:
  the map stuck at just its built-in `-1 -> "[empty]"` entry, so real
  enchantments never resolved and the tooltip fell back to the bare id for
  every one. `ObjectNames.init` now calls `bridge.dps.ParseEnchants#reload`
  once extraction completes (mirroring `CharacterClass.reload()`'s existing
  fix for the same race on `players.xml`), and `EnchantNames.envelopeJson()`
  tracks `ParseEnchants.ENCHANTS.size()` the same way `ItemInfo`/`LootBagTypes`
  track `loadedObjectCount()`, rebuilding the cached envelope when a reload
  changes it instead of caching the pre-extraction result forever.
- **Both re-sent every poll, not one-shot** - same rationale as
  `LootBagTypes` (§6): a tiny payload, re-sent so a client that connects after
  the first broadcast still gets it, with no separate request/response
  message. `PacketBridge` schedules them the same way (`maybeBroadcastItemInfo`
  `:169-170`; the enchant-names job `:176-177` - see the flushers table above).
- **How the overlay uses these**: `ItemSprite` (the shared item-rendering
  path every gear/loot icon goes through) reads `itemInfo` for the tooltip's
  name/tier/damage/description line, and decodes the *equipping* entity's raw
  `UNIQUE_DATA_STRING` stat (already crossing the wire on every player's
  stats - no new packet needed) client-side into enchant ids
  (`items/enchantDecode.ts`, a TypeScript port of
  `bridge.dps.ParseEnchants#extractEnchantIds` - the six-bit/base64url decode
  needs no XML, only `enchantNames` does), then resolves each id to a name via
  `enchantNames`, falling back to the bare id when no definition is loaded.
  See [overlay-renderer.md](overlay-renderer.md) for the full consumer side.

---

## Cross-references

- Envelope catalog (every `type` and its `data` shape): [architecture.md](architecture.md)
- DPS math and why self-damage is reconstructed: [dps-engine.md](dps-engine.md)
- Sprite-pack contents / `SpritePackService`: [asset-pipeline.md](asset-pipeline.md), [dyes-and-textiles.md](dyes-and-textiles.md)
- BagType extraction, `IdToAsset.registerFake`, and the Loot panel: [asset-pipeline.md](asset-pipeline.md), [overlay-renderer.md](overlay-renderer.md)
- Item tooltip data (`ItemInfo`/`EnchantNames`) and the enchant wire format: [asset-pipeline.md](asset-pipeline.md), [overlay-renderer.md](overlay-renderer.md)
- The client that consumes 47474 (supervisor, hello validation, reconnect): [overlay-main-process.md](overlay-main-process.md)
- Running with `--fake`, ports, the `bridge.jar`: [build-and-release.md](build-and-release.md)
