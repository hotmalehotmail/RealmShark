# The Java WebSocket bridge — how the server works

The **bridge** is the Java process that turns RealmShark's decoded packet stream
into a stream of JSON the overlay can consume. It subscribes to every decoded
`Packet`, serializes each one to a `{type,direction,time,data}` envelope, and
broadcasts them in batches over a **loopback-only** WebSocket on
`127.0.0.1:47474`. Alongside the raw packets it also emits three *synthetic*
envelope kinds the overlay needs but the game never sends: `objectNames`
(enemy id→name), `dps` (server-computed damage), and `spritePack` (the atlas
bundle). Capture runs on the sniffer thread; everything client-facing runs on a
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
    └─ dps.feed(packet)                      ▼        SpritePack (one-shot)         │
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

`PacketBridge` constructs and owns every collaborator (`PacketBridge.java:43-48`):

- `BridgeServer server` (the WebSocket server),
- `PacketSerializer serializer`,
- `ObjectNames objectNames`,
- `DpsBroadcaster dps`,
- `SpritePackService sprites`,
- `BlockingQueue<String> queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY)`.

The constructor also registers the inbound message handler:
`server.setMessageHandler(this::handleClientMessage)` (`PacketBridge.java:52`).

### Constants (read them here, not from memory)

| Constant | Value | Meaning | Ref |
| --- | --- | --- | --- |
| `DEFAULT_PORT` | `47474` | listen port unless `--port` overrides | `PacketBridge.java:38` |
| `QUEUE_CAPACITY` | `5000` | bounded queue; drop-oldest guard | `PacketBridge.java:39` |
| `FLUSH_INTERVAL_MS` | `33` | batch flush cadence (~30/sec) | `PacketBridge.java:40` |
| `DPS_INTERVAL_MS` | `250` | DPS snapshot cadence | `PacketBridge.java:41` |

### The `registerAll` subscription

`start(fake)` subscribes one lambda to *every* decoded packet
(`PacketBridge.java:101-110`):

```java
Register.INSTANCE.registerAll(packet -> {
    enqueue(serializer.toJson(packet));
    if (packet instanceof UpdatePacket) {
        String names = objectNames.envelopeFor((UpdatePacket) packet);
        if (names != null) enqueue(names);
    }
    dps.feed(packet);
});
```

`registerAll` installs the listener under the `Packet.class` key
(`packets/packetcapture/register/Register.java:66-68`), so it fires for *all*
packet classes. The same subscription serves both the real sniffer and
`--fake` mode, because both drive `Register` (the sniffer via `PacketProcessor`,
the fake source via `Register.INSTANCE.emitPacketLogs`, which dispatches to the
`Packet.class` listeners — `Register.java:35-38`).

So each `UpdatePacket` produces **two** enqueued messages: the packet envelope,
then a synthetic `objectNames` envelope (when any new object resolves to a name).

### The bounded, drop-oldest queue

`enqueue` never blocks and never throws (`PacketBridge.java:175-180`):

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
(`PacketBridge.java:183-196`). Each drained item is already a complete JSON
object, so the batch is assembled by string concatenation (not re-serialized).
Empty queue → no message. One WebSocket frame per flush (not per packet) keeps
frame counts low during dungeon bursts and lines up with a UI render frame.

> **Non-obvious fact.** A batch can interleave packet envelopes, `objectNames`,
> and `dps` envelopes — anything enqueued in the interval. Consumers must switch
> on each element's `type`, not assume a batch is homogeneous.

### The scheduled flushers

All four periodic jobs run on **one** single-thread daemon scheduler named
`bridge-flusher` (`PacketBridge.java:116-141`):

| Job | Cadence | What it does | Ref |
| --- | --- | --- | --- |
| `flush()` | 33 ms | drain queue → broadcast one `{"batch":[…]}` | `:121` |
| DPS snapshot | 250 ms | `dps.snapshotJson()`, enqueue if non-null | `:125-128` |
| engine diagnostic | 3000 ms | `System.out.println("[dps-engine] " + dps.debugState())` | `:132-134` |
| sprite-pack readiness | 2000 ms | `maybeBroadcastSpritePack()` (one-shot) | `:140-141` |

The DPS snapshot is *enqueued*, so it flows out with the next 33 ms flush like
any other message. The diagnostic writes to stdout only (it surfaces in the
overlay's Console panel; it is **not** sent to clients).

> **Comment vs. code.** The inline comment at `PacketBridge.java:122-124` says
> "500ms is plenty," but the actual snapshot cadence is `DPS_INTERVAL_MS = 250`
> (`:41`, scheduled at `:128`). The code is authoritative: 250 ms.

`maybeBroadcastSpritePack` (`PacketBridge.java:161-172`) exists because assets
extract/load on a background thread (see `ObjectNames.init` below) and usually
aren't ready when a client first connects. It polls `sprites.ready()`; once
ready it **broadcasts** the full pack to every client exactly once
(`spritePackSent` latch) so clients that got an early not-ready reply still get
real sprites. Until then it logs the not-ready diagnostic up to 6 times.

### CLI args & startup order

`main` parses two flags (`PacketBridge.java:75-91`):

- `--port <n>` — override the listen port (`Integer.parseInt(args[++i])`).
- `--fake` — emit synthetic packets instead of sniffing.

Unknown args print a warning and are ignored. `start(fake)` then runs in order
(`PacketBridge.java:93-151`):

1. `objectNames.init(fake)` — kick off background asset load.
2. `Register.INSTANCE.registerAll(...)` — subscribe.
3. `server.start()` — start the WebSocket server (its own thread).
4. schedule the four flusher jobs.
5. start the packet source: `new FakePacketSource().start()` if `--fake`, else
   `new PacketProcessor().start()` (the real Npcap sniffer).

### Client-message handling

`handleClientMessage` (`PacketBridge.java:60-73`) is the only inbound path.
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
that pack (atlases, `table`, `maskTable`, `dyeTable`) is documented in
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

The one thing excluded is the raw payload. The base class carries
`private byte[] data` (`packets/Packet.java:12`) — Gson reflects private fields,
so an `ExclusionStrategy` explicitly drops it (`PacketSerializer.java:29-39`):

```java
public boolean shouldSkipField(FieldAttributes f) {
    return f.getDeclaringClass() == Packet.class && "data".equals(f.getName());
}
```

The strategy keys on `declaringClass == Packet.class`, so it only skips the base
class's byte array — a subclass field that happened to be named `data` would
still be serialized.

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

## 6. `FakePacketSource` — `--fake` dev mode

`FakePacketSource` lets you run the whole bridge (and overlay) with **no game and
no Npcap**, by emitting synthetic packets through the *same* `Register` pipeline
the real sniffer uses (`Register.INSTANCE.emitPacketLogs(...)`), so nothing
downstream can tell the difference. It runs on a daemon thread
`fake-packet-source` (`FakePacketSource.java:78-82`). Launch it with
`./gradlew runBridge -Pargs="--fake"` — see [build-and-release.md](build-and-release.md).

### Simulated entities (constants, `FakePacketSource.java:42-72`)

| Thing | Value | Purpose |
| --- | --- | --- |
| Roster ids | `{1,2,3,4}` | four fake players Alice/Bob/Carol/Dave |
| Local player | `id 1` (Alice) | "you" |
| Enemy ids | `{100000,100001}` | two distinct DPS targets |
| Enemy types | `{1900,1901}` | objectTypes → resolved to names via `IdToAsset` |
| Pet id | `50` | a summon owned by the local player (minion attribution) |
| Weapon id | `4000` | what the local player "fires" (needs projectile damage in assets) |
| Skin id | `2500` | local player's equipped skin (Character panel) |
| Equipment | `{4000,4100,4200,4300}` | INVENTORY_0..3 slots |
| `FAKE_NO_CREATE_SUCCESS` env | flag | simulate a mid-session attach (no `CreateSuccessPacket`) |

### The emit loop (`FakePacketSource.java:84-136`)

Before the loop: emit a `MapInfoPacket` (seeds the engine RNG the damage roll
needs) and, unless `SKIP_CREATE_SUCCESS`, a `CreateSuccessPacket`. Then every
**300 ms tick**:

| When | Packets emitted | Why |
| --- | --- | --- |
| `tick % 15 == 0` | `rosterUpdate`, `enemyUpdate`, `petOwnership` | periodic resend so a late-connecting client still gets entity data within seconds |
| `tick > 0 && tick % 40 == 0` | `mapInfo`, `createSuccess`, `rosterUpdate`, `enemyUpdate`, `petOwnership` | fake **instance reset** — exercises the DPS tracker's reset-on-`MapInfoPacket`, immediately followed by a fresh entity burst |
| every tick | `newTick(tick)` | advancing server clock (`tickTime=300`, `serverRealTimeMS=tick*300`) — the engine's time base; without it every DPS is 0 |
| every tick | `localPlayerShoot(bulletId)` + `localPlayerHit(target,bulletId)` | the self-DPS path: outgoing `PlayerShootPacket` (weapon) matched by `EnemyHitPacket` (same `bulletId`); `EnemyHitPacket.mainID` also identifies the local player |
| every tick | `randomDamage()` | a `DamagePacket` (50–499 dmg) attributed to a random roster member, or ~1-in-5 to the pet |

`bulletId = tick % 100`; the focus target switches every ~20 ticks
(`ENEMY_IDS[(tick/20) % 2]`) to exercise focus-switching.

### What each builder produces

- **`rosterUpdate`** (`:204-228`) — an `UpdatePacket` with four `ObjectData`,
  each `objectType = 0x0300` (768, the synthetic player class). Non-local players
  get `playerStats` (a full maxed base+boost stat block + `NAME_STAT` +
  `EXALTATION_BONUS_DAMAGE`, so the engine can compute a maxed player's damage,
  `:246-266`). The local player gets `localPlayerStats` (base + `SKIN_ID`,
  `INVENTORY_0..3`, and `TEX1_STAT=4149`/`TEX2_STAT=4967` dye stats so the
  Character panel and dye compositing are exercised, `:273-290`; see
  [dyes-and-textiles.md](dyes-and-textiles.md)).
- **`enemyUpdate`** (`:307-327`) — an `UpdatePacket` with two `ObjectData`
  carrying `ENEMY_TYPES` and `enemyStats` but **no** `NAME_STAT`, exactly like a
  real monster, so `ObjectNames` names them from their type.
- **`createSuccess`** (`:139-145`) — assigns the local-player identity
  (`objectId=1, charId=1`).
- **`localPlayerHit`** (`:152-161`) — outgoing `EnemyHitPacket` with
  `shooterID=mainID=1`, `targetId=enemy`.
- **`localPlayerShoot`** (`:164-177`) — outgoing `PlayerShootPacket` with
  `weaponId=4000`.
- **`petOwnership`** (`:191-201`) — a `ServerPlayerShootPacket` establishing
  `ownerId=50` as a summon whose `summonerId=1` (the local player).
- **`mapInfo`** (`:330-340`) — increments an internal counter and names the realm
  `FakeRealm<N>`; each one is a fresh instance.
- **`randomDamage`** (`:347-359`) — a `DamagePacket` toward a random enemy, from a
  random roster member or (rng 1-in-5) the pet.

Together these exercise per-enemy DPS tracking, local-player focus-target
attribution, minion attribution, the object-name resolver, the Character panel,
dye compositing, and periodic instance resets — the full surface without a game.

---

## Cross-references

- Envelope catalog (every `type` and its `data` shape): [architecture.md](architecture.md)
- DPS math and why self-damage is reconstructed: [dps-engine.md](dps-engine.md)
- Sprite-pack contents / `SpritePackService`: [asset-pipeline.md](asset-pipeline.md), [dyes-and-textiles.md](dyes-and-textiles.md)
- The client that consumes 47474 (supervisor, hello validation, reconnect): [overlay-main-process.md](overlay-main-process.md)
- Running with `--fake`, ports, the `bridge.jar`: [build-and-release.md](build-and-release.md)
