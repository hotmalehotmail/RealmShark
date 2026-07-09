import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PORT = 47474
const PROBE_TIMEOUT_MS = 500
const PORT_FREE_POLL_MS = 150
const PORT_FREE_MAX_WAIT_MS = 3000

let child: ChildProcess | undefined

function jarPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bridge.jar')
    : join(__dirname, '../../../build/libs/bridge.jar')
}

/**
 * Path of the file recording the PID of the bridge WE spawned. It lets the
 * next launch reap a bridge that outlived its overlay (force-quit/crash, so
 * stopBridge never ran) instead of silently connecting to a stale bridge that
 * is no longer capturing - the exact failure that leaves the UI showing a
 * connected status but zero packets.
 */
function pidFilePath(): string {
  return join(app.getPath('userData'), 'bridge.pid')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function clearPidFile(): void {
  try {
    unlinkSync(pidFilePath())
  } catch {
    // Already gone - fine.
  }
}

/**
 * Kill a bridge this overlay spawned in a previous run that is still alive
 * (its overlay was force-quit/crashed before stopBridge could run). Only ever
 * targets a PID we recorded ourselves, so a bridge the user launched manually
 * - which has no pid file - is left untouched and simply connected to.
 */
async function reapOrphanedBridge(): Promise<void> {
  const path = pidFilePath()
  if (!existsSync(path)) return

  let pid = 0
  try {
    pid = parseInt(readFileSync(path, 'utf-8').trim(), 10)
  } catch {
    // Unreadable pid file - drop it and move on.
  }
  clearPidFile()

  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return

  try {
    process.kill(pid) // SIGTERM; on Windows this unconditionally terminates.
  } catch {
    // Process already gone (or not ours anymore) - nothing to reap.
    return
  }
  console.log('[bridge-supervisor] reaped orphaned bridge pid', pid)

  // Wait for the killed bridge to release the port before the caller decides
  // whether to spawn, so we don't briefly see the dying bridge as "listening".
  const deadline = Date.now() + PORT_FREE_MAX_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await isPortOpen())) return
    await delay(PORT_FREE_POLL_MS)
  }
}

/**
 * Spawns the bundled bridge jar if nothing is already listening on 47474 -
 * e.g. the user launched it manually. First reaps an orphaned bridge from a
 * previous crashed run (see reapOrphanedBridge). Requires a `java` runtime on
 * PATH; the bridge's own capture step is what actually needs elevation, not
 * this spawn.
 *
 * @param fake - passes --fake to the bridge, emitting synthetic packets instead
 * of sniffing. Used on platforms where electron-overlay-window can't attach
 * (i.e. anywhere but Windows/Linux) so the UI can still be exercised locally.
 */
export async function ensureBridgeRunning(fake: boolean): Promise<void> {
  await reapOrphanedBridge()

  if (await isPortOpen()) {
    console.log('[bridge-supervisor] bridge already listening, not spawning')
    return
  }

  const path = jarPath()
  const args = ['-jar', path, ...(fake ? ['--fake'] : [])]
  console.log('[bridge-supervisor] spawning bridge: java', args.join(' '))
  child = spawn('java', args, { stdio: 'pipe' })

  if (child.pid !== undefined) {
    writeFileSync(pidFilePath(), String(child.pid))
  }

  // Route through console.* (not process.stdout) so the bridge's own output is
  // captured by installMainConsoleCapture and reaches the renderer Console panel
  // - the packaged app has no terminal, so this is the only way a user sees it.
  child.stdout?.on('data', (data) => console.log(`[bridge] ${String(data).trimEnd()}`))
  child.stderr?.on('data', (data) => console.error(`[bridge] ${String(data).trimEnd()}`))
  child.on('error', (err) => {
    console.error('[bridge-supervisor] failed to spawn bridge (is Java installed?):', err.message)
    clearPidFile()
  })
  child.on('exit', (code) => {
    console.log('[bridge-supervisor] bridge process exited with code', code)
    child = undefined
    clearPidFile()
  })
}

export function stopBridge(): void {
  child?.kill()
  child = undefined
  clearPidFile()
}
