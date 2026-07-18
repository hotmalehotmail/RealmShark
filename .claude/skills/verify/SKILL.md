---
name: verify
description: How to run and observe this repo's two surfaces (Java bridge WS + Electron overlay) to verify changes end-to-end.
---

# Verifying changes in this repo

## Java / bridge changes — surface = the WebSocket on 127.0.0.1:47474

1. Toolchain (no committed wrapper; Gradle 9 breaks the Shadow plugin):
   ```bash
   export JAVA_HOME="/opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home"
   export PATH="$JAVA_HOME/bin:$PATH"
   # Gradle 7.4.2 pinned: /tmp/gradle-7.4.2/bin/gradle (download per CLAUDE.md if absent)
   ```
2. Run the bridge headless with synthetic traffic (no game/Npcap):
   ```bash
   /tmp/gradle-7.4.2/bin/gradle runBridge -Pargs="--fake" > bridge.log 2>&1 &
   ```
   Up within ~10s; `bridge.log` shows `[dps-engine]`/`[bridge]` lines.
   `java.io.FileNotFoundException: assets/xml/players.xml` at startup is
   normal in --fake mode (no extraction on disk).
3. Observe with Node ≥21's built-in WebSocket client (no deps):
   ```js
   const ws = new WebSocket("ws://127.0.0.1:47474");
   ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); /* msg.batch[] */ };
   ```
   - First frame: `{"type":"hello","service":"realmshark-bridge","protocol":1}`.
   - **Envelope `type` is the Java class name** (`"UpdatePacket"`, not
     `"UPDATE"`); synthetic envelopes are lowercase (`"lootBagTypes"`,
     `"dps"`, `"itemInfo"`).
   - Fake cadence: 300 ms/tick; loot-bag drop every 16 ticks (~5s), map reset
     every 40, transient player every 24 — capture ≥20s to see a full cycle.
4. Stop: `pkill -f "bridge.PacketBridge"; pkill -f "gradle.*runBridge"`.

## Overlay changes — surface = the Electron window

`cd overlay && npm run dev` (macOS falls back to a plain window with a
simulated attach). Screenshot recipe + renderer-console relay: see CLAUDE.md
"Local testing without Windows or the game". Panel gallery: `npm run shots`.

## CLI entry points

- `gradle extractFacts -PxmlDir=<dir>` — facts distiller (issue #189); missing
  dir → clear status + exit 2 (gradle fails loudly).
