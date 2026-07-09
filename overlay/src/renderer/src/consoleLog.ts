export type LogLevel = 'log' | 'info' | 'warn' | 'error'

export interface LogEntry {
  id: number
  level: LogLevel
  time: number
  message: string
}

const MAX_ENTRIES = 300
const LEVELS: LogLevel[] = ['log', 'info', 'warn', 'error']

const entries: LogEntry[] = []
const listeners = new Set<(entries: LogEntry[]) => void>()
let nextId = 1
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

function notify(): void {
  const snapshot = [...entries]
  for (const listener of listeners) listener(snapshot)
}

function push(level: LogLevel, time: number, message: string): void {
  entries.push({ id: nextId++, level, time, message })
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES)
  notify()
}

function record(level: LogLevel, args: unknown[]): void {
  push(level, Date.now(), args.map(formatArg).join(' '))
}

/** Merges a log entry captured in the main process (see preload's onMainLogEntry) into the same panel. */
export function ingestMainEntry(entry: { level: LogLevel; time: number; message: string }): void {
  push(entry.level, entry.time, `[main] ${entry.message}`)
}

/** Patches window.console once so every panel/module's console output is captured, not just future callers. */
export function installConsoleCapture(): void {
  if (patched) return
  patched = true
  for (const level of LEVELS) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]): void => {
      original(...args)
      record(level, args)
    }
  }
}

export function getLogEntries(): LogEntry[] {
  return [...entries]
}

export function subscribeLogEntries(cb: (entries: LogEntry[]) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function clearLogEntries(): void {
  entries.length = 0
  notify()
}
