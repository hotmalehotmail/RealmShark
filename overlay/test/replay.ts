import { readFileSync } from 'fs'
import { gunzipSync } from 'zlib'
import { vi } from 'vitest'
import type { PacketEnvelope } from '../src/shared/ipc'

/** Shape of a "Report bug" capture file (see `main/index.ts`'s `reportBug` handler). */
export interface CaptureFile {
  version?: string
  platform?: string
  arch?: string
  capturedAt?: string
  bridgeStatus?: string
  gameWindowTitle?: string
  recentPackets: PacketEnvelope[]
  mainLogs?: unknown
}

/**
 * Loads a capture fixture from disk. Accepts `.json` or `.json.gz`
 * (gzip-detected by extension, matching the `reportBug` handler's output),
 * and either a full capture file (`{..., recentPackets: [...]}`) or a bare
 * envelope array - so a hand-synthesized fixture doesn't need the wrapper.
 */
export function loadCapture(path: string): PacketEnvelope[] {
  const raw = readFileSync(path)
  const text = path.endsWith('.gz') ? gunzipSync(raw).toString('utf8') : raw.toString('utf8')
  const parsed: unknown = JSON.parse(text)
  if (Array.isArray(parsed)) return parsed as PacketEnvelope[]
  const capture = parsed as CaptureFile
  if (!Array.isArray(capture.recentPackets)) {
    throw new Error(`${path}: not a capture file ({recentPackets: [...]}) or a bare envelope array`)
  }
  return capture.recentPackets
}

/** Anything `replay`/`replayUntil` can feed packets to - both `DpsTracker` and `LootTracker` satisfy this. */
export interface Ingestible {
  ingest(packets: PacketEnvelope[]): unknown
}

export interface ReplayOptions {
  /** Invoked after each envelope is ingested, with the fake system time it was ingested at - the hook for asserting transient/intermediate state during a replay. */
  onStep?: (envelope: PacketEnvelope, index: number) => void
}

function asList(trackers: Ingestible | Ingestible[]): Ingestible[] {
  return Array.isArray(trackers) ? trackers : [trackers]
}

/**
 * Feeds `packets` (already loaded, e.g. via `loadCapture`) through one or
 * more trackers one envelope at a time, advancing vitest's fake system clock
 * to each envelope's own `time` before ingesting it - anchoring replay to
 * the capture's own timeline instead of wall-clock "now" (see
 * docs/overlay-test-suite.md and PRD D3). `DpsTracker.bossSnapshot` and
 * `LootTracker`'s drop timestamps compare against `Date.now()`; without this
 * anchoring, replaying a capture recorded days ago reads as "everything
 * already expired" and asserts nothing.
 *
 * Sets up and tears down `vi.useFakeTimers()` itself - call from inside a
 * test, not nested inside your own `vi.useFakeTimers()` block. For
 * mid-replay snapshots (checking transient state partway through), use
 * `replayUntil` instead.
 */
export function replay(
  trackers: Ingestible | Ingestible[],
  packets: PacketEnvelope[],
  opts: ReplayOptions = {}
): void {
  const list = asList(trackers)
  if (packets.length === 0) return
  vi.useFakeTimers()
  try {
    vi.setSystemTime(packets[0].time)
    packets.forEach((envelope, index) => {
      vi.setSystemTime(envelope.time)
      for (const tracker of list) tracker.ingest([envelope])
      opts.onStep?.(envelope, index)
    })
  } finally {
    vi.useRealTimers()
  }
}

/**
 * Like `replay`, but only feeds envelopes up to and including `untilTime`,
 * then pins the fake clock at `untilTime` and returns WITHOUT restoring real
 * timers - so the caller can immediately snapshot `Date.now()`-based tracker
 * state (e.g. `dpsTracker.bossSnapshot(Date.now(), WINDOW_MS)`) at that exact
 * point in the capture's timeline. The caller owns cleanup: call
 * `vi.useRealTimers()` once done inspecting the snapshot.
 */
export function replayUntil(
  trackers: Ingestible | Ingestible[],
  packets: PacketEnvelope[],
  untilTime: number,
  opts: ReplayOptions = {}
): void {
  const list = asList(trackers)
  if (packets.length === 0) return
  vi.useFakeTimers()
  vi.setSystemTime(packets[0].time)
  for (const [index, envelope] of packets.entries()) {
    if (envelope.time > untilTime) break
    vi.setSystemTime(envelope.time)
    for (const tracker of list) tracker.ingest([envelope])
    opts.onStep?.(envelope, index)
  }
  vi.setSystemTime(untilTime)
}
