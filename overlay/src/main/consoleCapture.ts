import type { LogLevel, MainLogEntry } from '../shared/ipc'

const MAX_ENTRIES = 300
const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error']

const buffer: MainLogEntry[] = []
let onEntry: ((entry: MainLogEntry) => void) | undefined
let patched = false

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return arg
  if (arg instanceof Error) return arg.stack ?? arg.message
  try {
    return JSON.stringify(arg)
  } catch {
    return String(arg)
  }
}

/**
 * Patches console.* in the main process so bridge-supervisor/bridge-client
 * status that would otherwise only be visible in a terminal (useless for a
 * packaged app) also reaches the renderer's console panel. Buffers entries
 * from process start so the panel can backfill anything logged before it
 * mounted (e.g. the bridge-supervisor spawn line).
 */
export function installMainConsoleCapture(): void {
  if (patched) return
  patched = true
  for (const level of LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      const entry: MainLogEntry = {
        level,
        time: Date.now(),
        message: args.map(formatArg).join(' ')
      }
      buffer.push(entry)
      if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES)
      onEntry?.(entry)
    }
  }
}

/** Registers the sink the renderer's live entries are pushed to once the overlay window exists. */
export function setMainLogSink(sink: (entry: MainLogEntry) => void): void {
  onEntry = sink
}

export function getBufferedMainLogs(): MainLogEntry[] {
  return [...buffer]
}
