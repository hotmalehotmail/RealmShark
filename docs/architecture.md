# Architecture & wire protocol

The top-level map of the RealmShark overlay system and the **canonical reference
for the local WebSocket wire protocol**. If you are wiring a new packet consumer,
adding a message type, or just trying to understand how a byte on the network
becomes a pixel in the overlay, start here. Individual subsystems have their own
docs (linked below); this one owns the *seams between them* and the exact JSON on
the wire.

## Files covered

| File | Role |
| --- | --- |
| `src/main/java/bridge/PacketBridge.java` | Bridge entry point: subscribes to every packet, serializes, queues, batch-flushes, hosts the DPS/objectNames/sprite side-channels. |
| `src/main/java/bridge/BridgeServer.java` | The loopback WebSocket server + hello frame. |
| `src/main/java/bridge/PacketSerializer.java` | Packet → `{type,direction,time,data}` JSON envelope (Gson). |
| `src/main/java/bridge/ObjectNames.java` | Synthetic `objectNames` envelope (enemy id → display name). |
| `src/main/java/bridge/DpsBroadcaster.java` | Synthetic `dps` snapshot envelope (bridge-computed damage). |
| `src/main/java/bridge/LootBagTypes.java` | Synthetic `lootBagTypes` envelope (item id → BagType, bag-color icon ids). |
| `src/main/java/bridge/sprites/SpritePackService.java` | `spritePack` request/response + one-shot broadcast. |
| `src/main/java/bridge/FakePacketSource.java` | `--fake` synthetic packet source (same `Register` pipeline). |
| `src/main/java/packets/packetcapture/PacketProcessor.java` | Sniffer → decode → `Register` (pre-existing upstream). |
| `src/main/java/packets/packetcapture/register/Register.java` | Pub/sub dispatch of decoded packets (pre-existing upstream). |
| `overlay/src/main/index.ts` | Electron main: window, supervisor + client wiring, IPC to renderer. |
| `overlay/src/main/bridgeSupervisor.ts` | Spawns/reaps the bundled `bridge.jar`. |
| `overlay/src/main/bridgeClient.ts` | WS client: validates hello, dispatches batches / sprite pack. |
| `overlay/src/main/spritePack.ts` | Caches the sprite pack; version-aware refetch. |
| `overlay/src/shared/ipc.ts` | Shared IPC channel names + `PacketEnvelope` / `SpritePack` types. |

Related docs (do not duplicate): [bridge-server.md](bridge-server.md) (Java queue/flush/Gson internals),
[dps-engine.md](dps-engine.md) (the ported damage engine), [asset-pipeline.md](asset-pipeline.md)
(extraction + flatbuffer), [overlay-main-process.md](overlay-main-process.md) (Electron main),
[overlay-renderer.md](overlay-renderer.md) (panels/React), [build-and-release.md](build-and-release.md)
(Gradle/electron-builder), [dyes-and-textiles.md](dyes-and-textiles.md) (dye compositing).

---

## 1. System overview — three tiers

```
┌─────────────────────────────────────┐   pre-existing upstream RealmShark
│  TIER 1  packet sniffer + decoder    │   (fork of X-com/RealmShark)
│  src/main/java/packets/…             │   sniff pcap → RC4 → typed Packet
└───────────────┬─────────────────────┘   dispatched via Register (pub/sub)
                │  decoded Packet objects (in-process, Java)
┌───────────────▼─────────────────────┐   NEW on the `bridge` branch
│  TIER 2  the bridge                  │   subscribes to every Packet,
│  src/main/java/bridge/…              │   serializes → JSON, batches,
│  bundled as build/libs/bridge.jar    │   broadcasts over loopback WS
└───────────────┬─────────────────────┘   ws://127.0.0.1:47474
                │  JSON messages (WebSocket, this doc's protocol)
┌───────────────▼─────────────────────┐   NEW on the `bridge` branch
│  TIER 3  the overlay (Electron)      │   WS client → IPC → React renderer
│  overlay/…                           │   panels: DPS, character, console…
└──────────────────────────────────────┘
```

**Pre-existing vs. new.** Tier 1 (`src/main/java/packets/**`) is the upstream
RealmShark library — the sniffer, RC4/reassembly, the `PacketType` enum, all the
`packets/incoming` / `packets/outgoing` / `packets/data` classes, and `Register`.
It reads network traffic only; it cannot send or modify packets. Tier 2
(`src/main/java/bridge/**`) and Tier 3 (`overlay/**`) are new work built on top of
the library. One nuance: `bridge/dps/**` (the DPS engine that `DpsBroadcaster`
drives) is **ported/adapted from upstream's `tomato` branch**, not written fresh
— see [dps-engine.md](dps-engine.md).

**Non-obvious fact.** The overlay is the only thing a user launches. It
*supervises* the bridge: `bridgeSupervisor.ts` probes `127.0.0.1:47474` and, if
nothing answers, spawns the bundled `bridge.jar` itself (`bridgeSupervisor.ts:174`).
There is no separate "start the bridge" step in normal use.

## 2. Map of the codebase

| Path | What it is | Doc |
| --- | --- | --- |
| `src/main/java/packets/` | Upstream sniffer + decoder → typed `Packet` objects via `Register`. | (upstream; skimmed here) |
| `src/main/java/assets/` | RotMG asset extraction: object XML, `IdToAsset`, `SpriteFlatBuffer`. | [asset-pipeline.md](asset-pipeline.md) |
| `src/main/java/bridge/` | The WebSocket bridge: server, serializer, side-channels, fake source. | [bridge-server.md](bridge-server.md) |
| `src/main/java/bridge/dps/` | Ported damage-attribution engine (from `tomato`). | [dps-engine.md](dps-engine.md) |
| `src/main/java/bridge/sprites/` | Builds the self-contained sprite pack (atlases + coord tables + dyes). | [dyes-and-textiles.md](dyes-and-textiles.md) |
| `overlay/src/main/` | Electron main process: window/attach, supervisor, WS client, IPC. | [overlay-main-process.md](overlay-main-process.md) |
| `overlay/src/preload/` | Context-bridge exposing `window.overlay.*` to the renderer. | [overlay-main-process.md](overlay-main-process.md) |
| `overlay/src/renderer/` | React UI: panel system, DPS tracker, sprite rendering. | [overlay-renderer.md](overlay-renderer.md) |
| `overlay/src/shared/` | Types shared main↔renderer (`ipc.ts`, `panels.ts`, `settings.ts`). | [overlay-main-process.md](overlay-main-process.md) |
| Gradle / `overlay/electron-builder.yml` | Build the jar; package the Windows installer. | [build-and-release.md](build-and-release.md) |

## 3. Life of a packet

Tracing one incoming packet (say a `DamagePacket`) from wire to render:

```
 ── TIER 1: Java, capture thread ────────────────────────────────────────────
 pcap frame (port 2050, TCP)
   │  Sniffer / PProcessor
   ▼
 PacketConstructor  ── reassemble + RC4 decrypt ──►  processPackets(type,size,buf)
   │                                                  PacketProcessor.java:124
   ▼
 PacketType.getPacket(type).factory()  ──►  packet.deserialize(BufferReader)
   │   (numeric opcode+direction → Packet subclass; fields populated)
   ▼
 Register.INSTANCE.emitPacketLogs(packet)            Register.java:28
   │   fan-out to every registerAll listener
 ── TIER 2: Java, still capture thread ──────────────────────────────────────
   ▼
 PacketBridge's registerAll lambda                   PacketBridge.java:106
   ├─ serializer.toJson(packet)  → {type,direction,time,data}  → enqueue()
   ├─ if UpdatePacket: objectNames.envelopeFor(p)   → enqueue() (may be null)
   └─ dps.feed(packet)   (updates the DPS engine; sets dpsDirty; no enqueue here)
   ▼
 BlockingQueue<String>  (cap 5000, drop-oldest)      PacketBridge.java:49
 ── TIER 2: Java, bridge-flusher thread (every 33 ms) ───────────────────────
   ▼
 flush(): drainTo(list) → join into {"batch":[ … ]} → server.send(...)
   │                                                  PacketBridge.java:197
   ▼   (a 50 ms-polling timer also enqueues a `dps` snapshot when dpsDirty,
   ▼    else on a 250 ms heartbeat; a 2 s poll also (re-)enqueues `lootBagTypes`
   ▼    once IdToAsset is loaded — see bridge-server.md)
 BridgeServer.broadcast(json)  ──►  WebSocket 127.0.0.1:47474
 ── TIER 3: Electron main process ───────────────────────────────────────────
   ▼
 bridgeClient ws 'message' → JSON.parse → msg.batch is an array
   │                                                  bridgeClient.ts:89
   ▼
 handlers.onBatch(batch)  →  webContents.send(IPC.packetBatch, batch)
   │                                                  index.ts:247
   ▼   preload: window.overlay.onPacketBatch(cb)      preload/index.ts:21
 ── TIER 3: renderer (React) ────────────────────────────────────────────────
   ▼
 DpsTracker.ingest(batch)   switch(env.type){ … }     DpsTracker.ts:82
 EntityRegistry              switch(env.type){ … }     EntityRegistry.tsx:129
 LootTracker.ingest(batch)   switch(env.type){ … }     LootTracker.ts
   ▼
 panels re-render (DPS list, character sprites, loot log, …)
```

Three facts that trip people up:

- **Serialization runs on the capture thread; sending runs on a timer thread.**
  The queue between them means a slow/dead client can never stall capture; on
  overflow the *oldest* message is dropped, not the newest (`PacketBridge.java:189`).
- **A batch mixes envelope kinds.** The `objectNames`, `dps`, and `lootBagTypes`
  envelopes are enqueued into the *same* queue as packet envelopes, so they
  arrive **inside** the `{"batch":[…]}` array, interleaved with real packets.
  Renderer consumers branch on each envelope's `type` string (`DpsTracker.ts:85`,
  `LootTracker.ts`).
- **The hello and `spritePack` messages are NOT batched** — they are sent
  directly (`conn.send` / `server.send`) and appear as top-level messages the
  client dispatches before it ever looks at `msg.batch`.

## 4. The WebSocket wire protocol — canonical reference

> This section owns the **message shapes** and the **connection lifecycle**. The
> Java-side mechanics (Gson field reflection, queue capacity, flush cadence) live
> in [bridge-server.md](bridge-server.md); the sprite-pack *contents* (atlas/dye
> tables) live in [dyes-and-textiles.md](dyes-and-textiles.md). Reference them —
> don't reproduce them here.

### Transport & binding

- **`ws://127.0.0.1:47474`** — plain WebSocket, **loopback only**. The server
  binds `new InetSocketAddress("127.0.0.1", port)` (`BridgeServer.java:31`), so
  sniffed game data can never leave the machine. Default port `47474`
  (`PacketBridge.java:38`); overridable with `--port <n>`. `setReuseAddr(true)`
  is set so a quick restart can rebind.
- Text frames only; every frame is one JSON object. No compression, no auth
  (loopback is the trust boundary).
- The server is broadcast-oriented: `server.send(x)` calls `broadcast(x)` to
  **all** connected clients (`BridgeServer.java:78`). The only per-client send is
  the sprite-pack response (below).

### Connection lifecycle

```
client connects ──► server onOpen ──► sends hello frame (first thing)
                                        BridgeServer.java:46
client validates hello.service == "realmshark-bridge"   bridgeClient.ts:67
   ├─ mismatch → close (some other process is squatting the port)
   └─ match    → status "connected"; fire onConnected(send)
                    onConnected → requestSpritePack(send)   index.ts:252
       thereafter: server broadcasts batches / dps / objectNames / lootBagTypes continuously;
                   client may send spritePackRequest at will
client drops ──► reconnect after 2000 ms   bridgeClient.ts:97
```

The client treats the connection as untrusted until the hello frame validates —
a stray listener on 47474 that doesn't send a correct hello is treated as
"disconnected," not silently accepted.

### 4a. Hello frame (server → client, once per connection)

```json
{ "type": "hello", "service": "realmshark-bridge", "protocol": 1 }
```

Emitted in `onOpen` before anything else (`BridgeServer.java:50`). `SERVICE` and
`PROTOCOL_VERSION` are constants (`BridgeServer.java:19-21`); bump `protocol`
only on a breaking envelope/handshake change.

### 4b. Batch envelope (server → client, ~30×/sec)

```json
{ "batch": [ <envelope>, <envelope>, … ] }
```

The **only** framing for the packet stream. `flush()` drains the queue and joins
already-serialized envelope strings into one array (`PacketBridge.java:202-209`). An
empty tick sends nothing. Each element is one of the envelope shapes below.
The client reads `msg.batch` (`bridgeClient.ts:89`) and forwards the raw array to
the renderer as `IPC.packetBatch`.

### 4c. Packet envelope (inside a batch)

Produced by `PacketSerializer.toJson` (`PacketSerializer.java:52`):

```json
{
  "type": "DamagePacket",          // packet.getClass().getSimpleName()
  "direction": "incoming",         // "incoming" | "outgoing" | "unknown"
  "time": 1720000000000,           // System.currentTimeMillis() at serialize
  "data": { …packet's public fields verbatim… }
}
```

- **`type`** is the Java simple class name (`DamagePacket`, `UpdatePacket`,
  `NewTickPacket`, …). Renderer consumers switch on this exact string.
- **`direction`** is computed by membership in `PacketType.getPacketTypeByDirection(true)`
  (the Incoming set): in-set → `"incoming"`, else `"outgoing"`, unknown class →
  `"unknown"` (`PacketSerializer.java:61`, `PacketType.java:278`). **These are the
  only three literal values on the wire.**
- **`data`** is the packet reflected field-for-field by Gson with **no custom
  serializers**, so JSON keys are the Java field names *exactly*, and nested data
  classes reflect the same way. **Enums serialize as their name string** (e.g.
  `"statType":"NAME_STAT"`, not a number). Before writing a consumer, read the
  actual `packets/incoming/*.java` / `packets/data/*.java` source, not just a wire
  sample.

> **Non-obvious fact — two different `data` fields.** The base `Packet` class has
> a raw `byte[] data` (the undecoded payload); the *envelope* also has a `data`
> field (the packet object). The serializer's exclusion strategy skips **only**
> `Packet.class`'s `data` byte array (`PacketSerializer.java:29`), so the raw
> bytes never hit the wire while the envelope's `data` (the decoded fields) does.

### 4d. `objectNames` envelope (inside a batch) — synthetic

Emitted alongside every `UpdatePacket` whose new objects resolve to names
(`ObjectNames.envelopeFor`, `PacketBridge.java:109`):

```json
{
  "type": "objectNames",
  "direction": "internal",
  "time": 1720000000000,
  "data": { "<objectId>": "<display name>", … }
}
```

`data` maps **string** object ids to enemy/NPC display names looked up from
extracted game assets (`ObjectNames.java:69`). Players are deliberately omitted —
they carry a `NAME_STAT` the client already names them from. Because
`UpdatePacket.newObjects` only holds newly-appeared objects, this is naturally
deduplicated. The envelope's field layout intentionally mirrors the packet
envelope (`type/direction/time/data`) so clients treat it uniformly; `direction`
is the sentinel `"internal"` (`ObjectNames.java:98`). Consumed at
`DpsTracker.ts:98`.

### 4e. `dps` envelope (inside a batch) — synthetic, event-driven

The bridge computes real damage attribution itself and ships a snapshot within
~50 ms of any damage packet (coalesced), or every 250 ms as a heartbeat when
idle (`PacketBridge.java:134-142`, `DpsBroadcaster.snapshotJson`) — see
`bridge-server.md` for the coalescing mechanics:

```json
{
  "type": "dps",
  "direction": "internal",
  "time": 1720000000000,
  "data": {
    "enemies": [
      {
        "id": 1234,
        "name": "Oryx the Mad God",
        "fightMs": 8250,
        "players": [
          { "id": 42, "name": "Alice", "damage": 190234, "dps": 23058.6 }
        ]
      }
    ]
  }
}
```

Only enemies the local player has hit are listed; per enemy, each attacking
player's total `damage` and average `dps` (= `damage / fightSec`). Pet/minion
damage is already folded into the owning player by the engine. `null` is returned
(nothing enqueued) when there is no fight to report. Field names in
`DpsBroadcaster.java:130-153` are the protocol; consumed at `DpsTracker.ts:101`.
The engine internals are [dps-engine.md](dps-engine.md).

### 4f. `lootBagTypes` envelope (inside a batch) — synthetic, re-sent periodically

Resolves which item ids are BagType 6 (white bag) / 8 (orange/ST bag) — the
Loot panel's session log (issue #105) — from the same extracted asset data
`ObjectNames` reads, independent of the sprite pack's atlas-readiness gate
(this data needs no atlas, only `IdToAsset`; see `asset-pipeline.md`):

```json
{
  "type": "lootBagTypes",
  "direction": "internal",
  "time": 1720000000000,
  "data": {
    "bagTypeTable": { "<itemObjectType>": 6 },
    "lootBagIcons": { "6": <bagObjectType>, "8": <bagObjectType> },
    "itemNames": { "<itemObjectType>": "<display name>" }
  }
}
```

`bagTypeTable` maps a **string** item objectType to its BagType (only 6/8
entries — untracked BagTypes are omitted, and the ground-bag entities
themselves, `Class=Bag`, are excluded so they can't be mistaken for
pickupable items). `lootBagIcons` maps each tracked BagType to the objectType
of the `Class=Bag` entity that self-identifies as that color — the sprite the
Loot panel renders as a category header, resolved through the same
`objectType → atlas rect` path as any other sprite (`sprites/Sprite.tsx`, no
special-casing). `itemNames` is `IdToAsset.objectName` for the same tracked
items, since the item pickup itself has no `UpdatePacket`/`objectId` of its
own to hang an `objectNames` entry off. Built by `LootBagTypes.envelopeJson()`
(`bridge/LootBagTypes.java`).

**Unlike the sprite pack (one-shot broadcast), this is re-sent on every 2 s
readiness poll** once `IdToAsset.loadedObjectCount() > 1`
(`PacketBridge.maybeBroadcastLootBagTypes`) rather than latched to a single
broadcast — the payload is tiny (two small id maps), and re-sending is the
simplest way to guarantee a client that connects *after* the first broadcast
still receives it, with no separate request/response message needed (unlike
`spritePackRequest` below). Consumed at `LootTracker.ingest`
(`overlay/src/renderer/src/loot/LootTracker.ts`).

### 4g. Sprite pack — request/response + one-shot broadcast (NOT batched)

The only **client → server** message today:

```json
{ "type": "spritePackRequest", "haveVersion": "v1720000000000" }
```

`haveVersion` is the version the client already cached, or `null` to force a full
send (`spritePack.ts:55`). Routed by `PacketBridge.handleClientMessage`
(`PacketBridge.java:65`), which replies **directly to that one client**
(`conn.send`) with one of three `spritePack` shapes from
`SpritePackService.responseFor` (`SpritePackService.java:71`):

| Condition | Response |
| --- | --- |
| assets not ready | `{"type":"spritePack","ready":false}` |
| client already current | `{"type":"spritePack","ready":true,"upToDate":true,"version":"v…"}` |
| full pack | `{"type":"spritePack","ready":true,"version":"v…","atlases":{…},"table":{…},"maskTable":{…},"dyeTable":{…},"animTable":{…}}` |

The full pack keys: `atlases` = `atlasId("1".."4") → data:image/png;base64,…`;
`table` = `objectType → [atlasId,x,y,w,h]`; `maskTable` = `objectType →
[3,x,y,w,h]`; `dyeTable` = `dyeId → [1,r,g,b]` (solid) or
`[10,atlasId,x0,y0,w0,h0,...]` (textile, one 4-tuple per animation frame);
`animTable` = `objectType → flat 9-ints/frame [x,y,w,h,aId,mx,my,mw,mh]` for
animated (idle) character sprites. The
`table`/`maskTable`/`dyeTable`/`animTable` semantics are documented in
[dyes-and-textiles.md](dyes-and-textiles.md); the TS mirror is `SpritePack` in
`overlay/src/shared/ipc.ts:74`.

**One-shot broadcast.** Assets load on a background thread, so early requests
often get `ready:false`. A 2 s watchdog (`PacketBridge.maybeBroadcastSpritePack`,
`PacketBridge.java:175`) fires once when assets become ready and
**broadcasts** the full pack (`server.send(responseFor(null))`) to every client,
so clients that got an early not-ready reply still receive real sprites without
re-asking. The client handles a top-level `spritePack` message
(`bridgeClient.ts:84`) identically whether it arrived as a reply or a broadcast.

> **Non-obvious fact — `version` is the atlas file mtime.** `version()` returns
> `"v" + characters.png.lastModified()` (`SpritePackService.java:58`). A game
> update re-extracts the atlas, changing the mtime, which invalidates the cache.
> Separately, `spritePack.ts:59` forces a full refetch if a cached pack predates
> `maskTable`/`dyeTable`/`animTable` even when the version matches.

### Message summary

| Message | Dir | Framing | Producer |
| --- | --- | --- | --- |
| `hello` | S→C | top-level, once | `BridgeServer.onOpen` |
| packet envelope | S→C | inside `batch` | `PacketSerializer` |
| `objectNames` | S→C | inside `batch` | `ObjectNames` |
| `dps` | S→C | inside `batch` | `DpsBroadcaster` |
| `lootBagTypes` | S→C | inside `batch`, re-sent every 2s poll | `LootBagTypes` |
| `spritePackRequest` | C→S | top-level | `spritePack.ts` |
| `spritePack` | S→C | top-level (reply or broadcast) | `SpritePackService` |

## 5. Process & launch model (big picture)

Detail lives in [overlay-main-process.md](overlay-main-process.md) and
[build-and-release.md](build-and-release.md); the essentials:

- **Single supervised bridge.** On startup the overlay calls
  `ensureBridgeRunning(fake)` (`index.ts:237`): it reaps any orphaned bridge from
  a prior run (via a PID file), and if nothing is already listening on 47474 it
  `spawn('java', ['-jar', bridge.jar, …])`. An externally-launched bridge (no PID
  file) is detected and simply connected to, never killed (`bridgeSupervisor.ts:182`).
  A crashed bridge is respawned with rate-limited backoff.
- **Single-instance lock.** `app.requestSingleInstanceLock()` (`index.ts:44`); a
  losing second launch quits immediately and does **no** startup, so it never
  reaps the first instance's healthy bridge.
- **`--fake` / non-Windows fallback.** `electron-overlay-window` can only attach
  to a real game window on **Windows or Linux X11**. `supportsAttach`
  (`index.ts:53`) is false elsewhere (e.g. macOS dev); in that case the overlay
  shows a plain window with a simulated attach, **and the supervisor passes
  `--fake` to the bridge** (`ensureBridgeRunning(!supportsAttach)`), which runs
  `FakePacketSource` through the same `Register` pipeline — a full dev loop with
  no game/Npcap. See [build-and-release.md](build-and-release.md).

The packaged app bundles `bridge.jar` as `resources/bridge.jar`
(`bridgeSupervisor.jarPath`, `bridgeSupervisor.ts:38`); it requires a `java`
runtime on PATH.

---

## Discrepancies found (code vs. CLAUDE.md / docs)

- **`direction` literal values.** `overlay/src/shared/ipc.ts:63` types
  `PacketEnvelope.direction` as `'CLIENT' | 'SERVER' | string`. The Java side
  never emits those; it emits **`"incoming"` / `"outgoing"` / `"unknown"`**
  (`PacketSerializer.java:64`). The `| string` fallback keeps it type-safe, but
  the enumerated literals are misleading — the real values are `incoming`/`outgoing`.
- **`objectNames` envelope shape.** `CLAUDE.md` and `dyes-and-textiles.md` show
  it as `{"type":"objectNames","data":{…}}`. The actual envelope also carries
  `direction:"internal"` and `time` (`ObjectNames.java:96`). Not wrong, just
  abbreviated — the full shape is in §4d.
- **Bridge-computed DPS is undocumented in CLAUDE.md's architecture section.**
  CLAUDE.md describes only the renderer-side `DpsTracker`; it omits that the
  bridge *also* computes DPS (`DpsBroadcaster` + the ported `bridge/dps` engine)
  and ships a `dps` envelope the renderer prefers. CLAUDE.md is incomplete here,
  not contradictory (the MEMORY note "DPS engine architecture" covers it).
- Everything else verified against source matches CLAUDE.md: port 47474 &
  loopback bind, hello frame contents, `{type,direction,time,data}` envelope,
  Gson reflecting field names verbatim with the raw `byte[]` excluded, drop-oldest
  queue, single-instance lock, and the `--fake`/non-Windows fallback.
</content>
</invoke>
