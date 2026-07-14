import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { vi } from 'vitest'
import type { PacketEnvelope } from '../src/shared/ipc'

/** Anything that consumes the same envelope-array shape a capture's `recentPackets` field holds. */
export interface Ingestable {
  ingest(packets: PacketEnvelope[]): unknown
}

/** The shape `IPC.reportBug` writes (main/index.ts) - only `recentPackets` matters for replay. */
interface CaptureFile {
  recentPackets?: PacketEnvelope[]
}

/**
 * Loads a bug-report capture fixture: `.json` or `.json.gz` (detected by
 * extension, falling back to gzip-magic-byte sniffing so a misnamed file
 * still loads), containing either a full capture object (`{recentPackets,
 * ...}`, the shape `IPC.reportBug` writes - see main/index.ts) or a bare
 * `PacketEnvelope[]`. Returns envelopes sorted chronologically by
 * `envelope.time`, since `replay()`'s fake-timer anchoring depends on
 * strictly non-decreasing time.
 */
export function loadCapture(filePath: string): PacketEnvelope[] {
  const raw = readFileSync(filePath)
  const isGzip = filePath.endsWith('.gz') || (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b)
  const text = (isGzip ? gunzipSync(raw) : raw).toString('utf8')
  const parsed = JSON.parse(text) as PacketEnvelope[] | CaptureFile
  const envelopes = Array.isArray(parsed) ? parsed : (parsed.recentPackets ?? [])
  return [...envelopes].sort((a, b) => a.time - b.time)
}

export interface ReplayOptions {
  /**
   * Only ingest envelopes with `time <= untilMs` (inclusive); the fake clock
   * is left parked at `untilMs` afterward rather than the last ingested
   * envelope's own time, so a snapshot taken right after reflects "state as
   * of `untilMs`" even if nothing happened exactly then. Omit to replay the
   * whole capture, parking the clock at the last envelope's time.
   */
  untilMs?: number
}

/**
 * Replays `envelopes` into one or more trackers (anything with an
 * `ingest(packets: PacketEnvelope[])` method, e.g. `DpsTracker`/
 * `LootTracker`) using vitest fake timers anchored to each envelope's own
 * `time` field (PRD D3 / docs/overlay-testing.md): `Date.now()` inside the
 * tracker reads as that envelope's original wall-clock time, not "now", so
 * rolling-window / carry-forward logic keyed on `Date.now()` behaves exactly
 * as it did live instead of reading a replayed old capture as "everything
 * expired."
 *
 * Calls `vi.useFakeTimers()` itself; the caller owns tearing it down
 * (`vi.useRealTimers()` in `afterEach`) since a test may want to keep
 * inspecting fake-clock state after replay returns.
 *
 * Re-calling `replay()` on a tracker that has already ingested part of this
 * same envelope list double-ingests those envelopes (trackers accumulate
 * state, e.g. damage buffers) - for a mid-replay snapshot, use a fresh
 * tracker instance per `replayUntil` call rather than resuming one.
 */
export function replay(
  trackers: Ingestable | Ingestable[],
  envelopes: PacketEnvelope[],
  opts: ReplayOptions = {}
): void {
  vi.useFakeTimers()
  const list = Array.isArray(trackers) ? trackers : [trackers]
  const sorted = [...envelopes].sort((a, b) => a.time - b.time)
  for (const envelope of sorted) {
    if (opts.untilMs !== undefined && envelope.time > opts.untilMs) break
    vi.setSystemTime(envelope.time)
    for (const tracker of list) tracker.ingest([envelope])
  }
  if (opts.untilMs !== undefined) vi.setSystemTime(opts.untilMs)
}

/**
 * `replay()` with a `time` cutoff - the way to snapshot a transient
 * mid-fight/mid-drop state instead of the capture's final state. Pass a
 * fresh tracker instance (see `replay()`'s re-ingest caveat).
 */
export function replayUntil(
  trackers: Ingestable | Ingestable[],
  envelopes: PacketEnvelope[],
  untilMs: number
): void {
  replay(trackers, envelopes, { untilMs })
}
