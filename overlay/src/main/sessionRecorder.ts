import { app } from 'electron'
import { join } from 'path'
import type { PacketEnvelope } from '../shared/ipc'
import { SessionRecordingWriter } from '../shared/sessionRecording'

let writer: SessionRecordingWriter | null = null

/** Starts appending allowlisted batches to `userData/captures/*.ndjson.gz`. No-op if already recording. */
export function startRecording(): void {
  if (writer) return
  writer = new SessionRecordingWriter(join(app.getPath('userData'), 'captures'))
}

/** Flushes and closes the current recording file. Safe to call when not recording. */
export function stopRecording(): void {
  const current = writer
  writer = null
  void current?.close()
}

/** Appends `packets` to the current recording, if one is active; otherwise a no-op. */
export function recordBatch(packets: PacketEnvelope[]): void {
  writer?.writeBatch(packets)
}
