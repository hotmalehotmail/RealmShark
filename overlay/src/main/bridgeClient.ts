import WebSocket from 'ws'
import type { BridgeStatus, SpritePack } from '../shared/ipc'

const BRIDGE_URL = 'ws://127.0.0.1:47474'
const EXPECTED_SERVICE = 'realmshark-bridge'
const RECONNECT_DELAY_MS = 2000

interface BridgeClientHandlers {
  onStatus: (status: BridgeStatus) => void
  onBatch: (packets: unknown[]) => void
  /** Called once the hello frame is validated, with a fn to send a message upstream. */
  onConnected?: (send: (msg: unknown) => void) => void
  /** A non-batch typed control message (currently only the sprite pack). */
  onSpritePack?: (pack: SpritePack & { upToDate?: boolean }) => void
}

// Once true (set by stopBridgeClient on quit), no further connects or
// reconnects happen. Reset on each startBridgeClient call.
let stopped = false
// The live socket, tracked so stopBridgeClient can tear it down on quit.
let activeSocket: WebSocket | null = null

/**
 * Connects to the RealmShark Java bridge and reconnects on drop. Validates the
 * hello frame so a stray process squatting on the port is treated as "disconnected"
 * rather than silently accepted.
 */
export function startBridgeClient(handlers: BridgeClientHandlers): void {
  stopped = false
  connect(handlers)
}

/**
 * Permanently stops the client (on app quit). Closes the active socket with its
 * listeners removed so its `close` event can't fire another onStatus/reconnect
 * into an already-destroyed overlay window.
 */
export function stopBridgeClient(): void {
  stopped = true
  if (activeSocket) {
    activeSocket.removeAllListeners()
    activeSocket.close()
    activeSocket = null
  }
}

function connect(handlers: BridgeClientHandlers): void {
  if (stopped) return
  handlers.onStatus('connecting')
  const ws = new WebSocket(BRIDGE_URL)
  activeSocket = ws
  let verified = false

  ws.on('open', () => {
    // Wait for the hello frame before trusting this connection.
  })

  ws.on('message', (raw) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (!verified) {
      if (msg.type === 'hello' && msg.service === EXPECTED_SERVICE) {
        verified = true
        handlers.onStatus('connected')
        handlers.onConnected?.((out) => {
          try {
            ws.send(JSON.stringify(out))
          } catch {
            // socket already closing; the reconnect will re-request
          }
        })
      } else {
        console.error('[bridge-client] unexpected hello frame, closing:', msg)
        ws.close()
      }
      return
    }

    if (msg.type === 'spritePack') {
      handlers.onSpritePack?.(msg as unknown as SpritePack & { upToDate?: boolean })
      return
    }

    if (Array.isArray(msg.batch)) {
      handlers.onBatch(msg.batch)
    }
  })

  const scheduleReconnect = (): void => {
    if (stopped) return
    handlers.onStatus('disconnected')
    setTimeout(() => connect(handlers), RECONNECT_DELAY_MS)
  }

  ws.on('close', scheduleReconnect)
  ws.on('error', (err) => {
    console.error('[bridge-client] error:', err.message)
    ws.close()
  })
}
