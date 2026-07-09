import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { connect } from 'net'
import { join } from 'path'

const BRIDGE_HOST = '127.0.0.1'
const BRIDGE_PORT = 47474
const PROBE_TIMEOUT_MS = 500
const PORT_FREE_POLL_MS = 150
const PORT_FREE_MAX_WAIT_MS = 3000

// Auto-relaunch tuning. The bridge's capture layer is native (Npcap via the
// ardikars binding) and can crash the JVM outright (e.g. STATUS_HEAP_CORRUPTION,
// exit code 0xC0000374) rather than throw. When that happens we respawn so the
// overlay self-heals, but cap the rate so a bridge that crashes on every start
// doesn't spin the CPU forever.
const RESTART_BACKOFF_MS = 2000
const RESTART_MAX = 5
const RESTART_WINDOW_MS = 60_000

let child: ChildProcess | undefined

// True only while stopBridge() is tearing the bridge down on purpose (app quit),
// so the child's `exit` handler can tell an intentional stop from a crash and
// skip respawning in the former case.
let intentionalStop = false
// The --fake mode of the last ensureBridgeRunning() call, so an auto-respawn
// re-runs in the same mode without the caller being involved.
let lastFakeMode = false
// Timestamps (ms) of recent auto-respawns, pruned to a rolling window, to detect
// a crash loop. A run that survives the window empties this naturally.
let restartTimes: number[] = []
// Handle of a pending backoff timer, so stopBridge() can cancel a respawn that
// was scheduled but hasn't fired yet.
let respawnTimer: ReturnType<typeof setTimeout> | undefined

function jarPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'bridge.jar')
    : join(__dirname, '../../../build/libs/bridge.jar')
}

/**
 * Path of the file recording the PID of the bridge we spawned. It lets the next
 * launch reap a bridge that outlived its overlay (crash, or a quit whose kill
 * didn't take) instead of connecting to a stale bridge that's no longer
 * capturing - the failure that shows a "connected" status with zero packets.
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

function readPidFile(): number | undefined {
  try {
    if (!existsSync(pidFilePath())) return undefined
    const pid = parseInt(readFileSync(pidFilePath(), 'utf-8').trim(), 10)
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

function writePidFile(pid: number): void {
  try {
    writeFileSync(pidFilePath(), String(pid))
  } catch {
    // Non-fatal: we lose orphan-reaping for this run, but the bridge still works.
  }
}

function clearPidFile(): void {
  try {
    unlinkSync(pidFilePath())
  } catch {
    // Already gone - fine.
  }
}

/**
 * Whether `pid` is a live `java` process. Guards the force-kill against a
 * recycled PID: between overlay runs the OS may reuse our old bridge's PID for
 * an unrelated process, and we must never kill that.
 */
function isJavaPid(pid: number): boolean {
  try {
    if (process.platform === 'win32') {
      const out = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
        encoding: 'utf-8'
      })
      return /java/i.test(out.stdout ?? '')
    }
    const out = spawnSync('ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf-8' })
    return /java/i.test(out.stdout ?? '')
  } catch {
    return false
  }
}

/**
 * Force-kill a PID (and its child tree on Windows), synchronously. `child.kill()`
 * (SIGTERM) is unreliable for a spawned `java.exe` on Windows - `taskkill /T /F`
 * is not. Synchronous so it completes during the quit sequence before the app
 * exits. No-op if the process is already gone.
 */
function forceKill(pid: number): void {
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'])
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    // Already dead / not killable - nothing to do.
  }
}

/**
 * Kill a bridge a previous overlay run spawned that is still alive (its overlay
 * crashed, or a quit's kill didn't take). Only ever targets a PID we recorded
 * and confirmed is still a java process, so a bridge the user launched manually
 * - which has no pid file - is left untouched and simply connected to.
 */
async function reapOrphanedBridge(): Promise<void> {
  const pid = readPidFile()
  if (pid === undefined) return

  // Stale or reused PID: drop the record and move on without killing anything.
  if (pid === process.pid || !isJavaPid(pid)) {
    clearPidFile()
    return
  }

  console.log('[bridge-supervisor] reaping orphaned bridge pid', pid)
  forceKill(pid)
  clearPidFile()

  // Wait for the killed bridge to release the port before the caller decides
  // whether to spawn, so we don't briefly see the dying bridge as "listening".
  const deadline = Date.now() + PORT_FREE_MAX_WAIT_MS
  while (Date.now() < deadline) {
    if (!(await isPortOpen())) return
    await delay(PORT_FREE_POLL_MS)
  }
}

/**
 * Reap any orphaned bridge, then spawn the bundled jar unless something is still
 * listening on 47474 (an external bridge the user launched, which has no pid
 * file and so was not reaped). Requires a `java` runtime on PATH.
 *
 * @param fake - passes --fake to the bridge, emitting synthetic packets instead
 * of sniffing. Used on platforms where electron-overlay-window can't attach
 * (i.e. anywhere but Windows/Linux) so the UI can still be exercised locally.
 */
export async function ensureBridgeRunning(fake: boolean): Promise<void> {
  // Remember the mode and mark that we're (re)spawning on purpose, so a stale
  // intentionalStop from a prior teardown can't suppress this run's exit handler.
  lastFakeMode = fake
  intentionalStop = false

  await reapOrphanedBridge()

  if (await isPortOpen()) {
    console.log('[bridge-supervisor] bridge already listening (external), not spawning')
    return
  }

  const path = jarPath()
  const args = ['-jar', path, ...(fake ? ['--fake'] : [])]
  console.log('[bridge-supervisor] spawning bridge: java', args.join(' '))
  child = spawn('java', args, { stdio: 'pipe' })

  if (child.pid !== undefined) {
    writePidFile(child.pid)
    console.log('[bridge-supervisor] bridge pid', child.pid)
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

    // An intentional stop (app quit) is expected - don't fight it by respawning.
    if (intentionalStop) return

    scheduleRespawn(code)
  })
}

/**
 * Respawn a bridge WE spawned that exited unexpectedly (a crash - a native
 * capture-layer fault or the JVM dying), unless we've restarted too many times
 * in a short window, in which case we give up to avoid a CPU-spinning crash
 * loop. A run that survives longer than the window empties `restartTimes`, so
 * an occasional crash always gets the full retry budget again.
 */
function scheduleRespawn(code: number | null): void {
  const now = Date.now()
  restartTimes = restartTimes.filter((t) => now - t < RESTART_WINDOW_MS)

  if (restartTimes.length >= RESTART_MAX) {
    console.error(
      `[bridge-supervisor] bridge keeps exiting (code ${code}); giving up after ${restartTimes.length} restarts within ${RESTART_WINDOW_MS / 1000}s`
    )
    return
  }

  restartTimes.push(now)
  const attempt = restartTimes.length
  console.error(
    `[bridge-supervisor] bridge exited unexpectedly (code ${code}), relaunching in ${RESTART_BACKOFF_MS / 1000}s (attempt ${attempt}/${RESTART_MAX})`
  )

  respawnTimer = setTimeout(() => {
    respawnTimer = undefined
    // A quit may have raced in during the backoff; bail rather than resurrect.
    if (intentionalStop) return
    void ensureBridgeRunning(lastFakeMode).catch((err) => {
      console.error('[bridge-supervisor] respawn failed:', err)
    })
  }, RESTART_BACKOFF_MS)
}

/**
 * Kill the bridge we're responsible for. Uses the spawned child's PID if we have
 * one, else the pid file (covers connecting to an orphan we didn't spawn this
 * run). A force-kill so a Windows quit actually terminates java; the pid file is
 * cleared afterward.
 */
export function stopBridge(): void {
  // Mark the teardown as intentional and cancel any pending auto-respawn so the
  // child's exit handler (and a scheduled backoff) won't resurrect the bridge
  // during app quit.
  intentionalStop = true
  if (respawnTimer !== undefined) {
    clearTimeout(respawnTimer)
    respawnTimer = undefined
  }

  const spawnedPid = child?.pid
  child = undefined

  if (spawnedPid !== undefined) {
    console.log('[bridge-supervisor] stopping bridge pid', spawnedPid)
    forceKill(spawnedPid)
  } else {
    const pid = readPidFile()
    if (pid !== undefined && pid !== process.pid && isJavaPid(pid)) {
      console.log('[bridge-supervisor] stopping orphaned bridge pid', pid)
      forceKill(pid)
    }
  }
  clearPidFile()
}
