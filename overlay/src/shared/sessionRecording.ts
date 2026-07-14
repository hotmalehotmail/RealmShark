import { createWriteStream, mkdirSync, unlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { createGzip, type Gzip } from 'zlib'
import { CAPTURE_ALLOWED_TYPES } from './capture'
import type { PacketEnvelope } from './ipc'

/**
 * Size threshold, in *uncompressed* NDJSON bytes written to the current file,
 * at which a recording file rotates to a new one. Measured pre-gzip (not the
 * resulting on-disk file size) because the gzip stream buffers internally, so
 * the compressed byte count isn't available synchronously right after a
 * write - a written-bytes counter is exact and immediate, at the cost of the
 * actual `.ndjson.gz` file landing well under 50 MB (NDJSON packet traffic
 * compresses hard). ~50 MB of input keeps an always-on recorder from eating
 * the disk over a long session while still covering a good stretch of play -
 * see docs/overlay-main-process.md.
 */
export const RECORDING_ROTATE_BYTES = 50 * 1024 * 1024

/**
 * Number of most-recent recording files kept under the captures directory;
 * once more than this many exist, the oldest are deleted. 10 files * ~50 MB
 * caps the recorder at roughly 500 MB of disk.
 */
export const RECORDING_RETAIN_FILES = 10

const FILE_SUFFIX = '.ndjson.gz'

/** Monotonic across the process lifetime so two files opened within the same millisecond never collide. */
let fileCounter = 0

function timestampedFileName(): string {
  fileCounter += 1
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return `session-${stamp}-${String(fileCounter).padStart(6, '0')}${FILE_SUFFIX}`
}

/** One file this writer has created, tracked in creation order for retention. */
interface TrackedFile {
  path: string
  /** True once its underlying stream has actually finished flushing - only then can it be safely deleted (Windows refuses to delete a still-open file). */
  closed: boolean
}

/**
 * Appends allowlist-filtered packet batches as NDJSON (one envelope per line)
 * to a rolling, gzip-compressed file under `dir`, rotating at `rotateBytes`
 * and keeping only the last `retainFiles` files (PRD §7.2). Pure Node
 * (`fs`/`zlib` only, no Electron) so it's constructible against a plain temp
 * directory in tests; `overlay/src/main/sessionRecorder.ts` is the thin
 * Electron-facing wrapper that points it at `userData/captures`.
 *
 * A writer is "recording" for its whole lifetime - construct one to start,
 * call `close()` to stop. Each instance opens its first file immediately.
 *
 * Retention is tracked in-memory (creation order), not by re-listing the
 * directory: a rotated-out file is only actually deleted once its stream's
 * `finish` event confirms it's fully closed, since a rotation ends the old
 * stream and opens the new one without waiting - deleting a file whose
 * handle hasn't finished closing yet would fail on Windows and is best
 * avoided everywhere.
 */
export class SessionRecordingWriter {
  private readonly dir: string
  private readonly rotateBytes: number
  private readonly retainFiles: number
  private gzip: Gzip | null = null
  /** Uncompressed bytes written to the *current* file - see RECORDING_ROTATE_BYTES's doc comment for why this, not the on-disk size, drives rotation. */
  private uncompressedBytes = 0
  /** Every file created this session that hasn't been deleted yet, oldest first. */
  private readonly files: TrackedFile[] = []
  /** One per file, resolving once that file's stream has finished; `close()` awaits all of them so every pending rotation/prune has settled. */
  private readonly pendingFinishes: Promise<void>[] = []

  constructor(dir: string, opts: { rotateBytes?: number; retainFiles?: number } = {}) {
    this.dir = dir
    this.rotateBytes = opts.rotateBytes ?? RECORDING_ROTATE_BYTES
    this.retainFiles = opts.retainFiles ?? RECORDING_RETAIN_FILES
    mkdirSync(this.dir, { recursive: true })
    this.openNewFile()
  }

  private openNewFile(): void {
    const path = join(this.dir, timestampedFileName())
    // Touch synchronously so the file is visible on disk immediately, even
    // though fs.createWriteStream's own open happens async.
    writeFileSync(path, '')
    const fileStream = createWriteStream(path, { flags: 'a' })
    const gzip = createGzip()
    gzip.pipe(fileStream)
    this.gzip = gzip
    this.uncompressedBytes = 0

    const record: TrackedFile = { path, closed: false }
    this.files.push(record)
    this.pendingFinishes.push(
      new Promise<void>((resolve) => {
        fileStream.once('finish', () => {
          record.closed = true
          this.pruneOldFiles()
          resolve()
        })
      })
    )
  }

  /** Deletes the oldest tracked files past `retainFiles`, stopping at the first one still open - it's retried automatically once that file's own `finish` fires. */
  private pruneOldFiles(): void {
    while (this.files.length > this.retainFiles && this.files[0].closed) {
      const stale = this.files.shift()!
      unlinkSync(stale.path)
    }
  }

  private rotate(): void {
    // Fire-and-forget: the old gzip stream finishes flushing (and, once it
    // does, becomes eligible for retention pruning) in the background while
    // the new file starts accepting writes immediately.
    this.gzip?.end()
    this.openNewFile()
  }

  /**
   * Appends every allowlisted envelope in `packets` as one NDJSON line each
   * (same `CAPTURE_ALLOWED_TYPES` filter as the capture ring - identical
   * privacy posture, since these files are meant to be shareable too), then
   * rotates if the current file has grown past `rotateBytes`. A batch
   * containing only disallowed types is a no-op.
   */
  writeBatch(packets: PacketEnvelope[]): void {
    if (!this.gzip) return
    for (const packet of packets) {
      if (!CAPTURE_ALLOWED_TYPES.has(packet.type)) continue
      const line = JSON.stringify(packet) + '\n'
      this.gzip.write(line)
      this.uncompressedBytes += Buffer.byteLength(line, 'utf8')
    }
    if (this.uncompressedBytes >= this.rotateBytes) {
      this.rotate()
    }
  }

  /**
   * Flushes and closes the current file cleanly. Resolves once every file
   * this writer ever opened (including earlier rotations still flushing in
   * the background) has finished and any resulting retention pruning has
   * run, so callers that need the final directory state immediately after
   * (tests; a clean app-quit) can await it.
   */
  close(): Promise<void> {
    this.gzip?.end()
    this.gzip = null
    return Promise.all(this.pendingFinishes).then(() => undefined)
  }
}
