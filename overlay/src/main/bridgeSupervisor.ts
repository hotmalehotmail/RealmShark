import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { connect } from 'net'
import { join } from 'path'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PORT = 47474
const PROBE_TIMEOUT_MS = 500

let child: ChildProcess | undefined

function jarPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bridge.jar')
    : join(__dirname, '../../../build/libs/bridge.jar')
}

function isPortOpen(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: BRIDGE_HOST, port: BRIDGE_PORT })
    const done = (result: boolean): void => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(PROBE_TIMEOUT_MS)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/**
 * Spawns the bundled bridge jar if nothing is already listening on 47474 -
 * e.g. the user launched it manually, or a previous overlay instance's child
 * is still running. Requires a `java` runtime on PATH; the bridge's own
 * capture step is what actually needs elevation, not this spawn.
 */
export async function ensureBridgeRunning(): Promise<void> {
  if (await isPortOpen()) {
    console.log('[bridge-supervisor] bridge already listening, not spawning')
    return
  }

  const path = jarPath()
  console.log('[bridge-supervisor] spawning bridge:', path)
  child = spawn('java', ['-jar', path], { stdio: 'pipe' })

  child.stdout?.on('data', (data) => process.stdout.write(`[bridge] ${data}`))
  child.stderr?.on('data', (data) => process.stderr.write(`[bridge] ${data}`))
  child.on('error', (err) => {
    console.error('[bridge-supervisor] failed to spawn bridge (is Java installed?):', err.message)
  })
  child.on('exit', (code) => {
    console.log('[bridge-supervisor] bridge process exited with code', code)
    child = undefined
  })
}

export function stopBridge(): void {
  child?.kill()
  child = undefined
}
