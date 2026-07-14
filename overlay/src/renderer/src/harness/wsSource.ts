import type { BridgeStatus, PacketEnvelope, SpritePack } from '../../../shared/ipc'

const BRIDGE_URL = 'ws://127.0.0.1:47474'
const EXPECTED_SERVICE = 'realmshark-bridge'
const RECONNECT_DELAY_MS = 2000

export interface HarnessSink {
  onBatch: (packets: PacketEnvelope[]) => void
  onSpritePack: (pack: SpritePack) => void
  onStatus: (status: BridgeStatus) => void
}

/**
 * Live-fake data source (PRD §5.2 bullet 1): a page-side WebSocket straight to
 * the real bridge, exactly what `gradle runBridge -Pargs="--fake"` serves on
 * `127.0.0.1:47474` - real Java, real `FakePacketSource`, zero Electron.
 * Mirrors `overlay/src/main/bridgeClient.ts` (hello-frame validation,
 * `{"batch":[...]}` parsing, the `spritePack` control message) using the
 * browser's native `WebSocket` instead of the `ws` package, since this module
 * runs in Chromium, not Node.
 */
export function startWsSource(sink: HarnessSink): void {
  connect(sink)
}

function connect(sink: HarnessSink): void {
  sink.onStatus('connecting')
  const ws = new WebSocket(BRIDGE_URL)
  let verified = false

  ws.onmessage = (ev): void => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(ev.data as string)
    } catch {
      return
    }

    if (!verified) {
      if (msg.type === 'hello' && msg.service === EXPECTED_SERVICE) {
        verified = true
        sink.onStatus('connected')
        try {
          ws.send(JSON.stringify({ type: 'spritePackRequest', haveVersion: null }))
        } catch {
          // socket already closing; the reconnect below will re-request
        }
      } else {
        console.error('[harness/ws] unexpected hello frame, closing:', msg)
        ws.close()
      }
      return
    }

    if (msg.type === 'spritePack') {
      sink.onSpritePack(msg as unknown as SpritePack)
      return
    }

    if (Array.isArray(msg.batch)) {
      sink.onBatch(msg.batch as PacketEnvelope[])
    }
  }

  const scheduleReconnect = (): void => {
    sink.onStatus('disconnected')
    setTimeout(() => connect(sink), RECONNECT_DELAY_MS)
  }

  ws.onclose = scheduleReconnect
  ws.onerror = (): void => {
    console.error('[harness/ws] connection error - is `gradle runBridge -Pargs="--fake"` running?')
    ws.close()
  }
}
