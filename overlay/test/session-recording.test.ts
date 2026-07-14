import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PacketEnvelope } from '../src/shared/ipc'
import { SessionRecordingWriter } from '../src/shared/sessionRecording'

function env(type: string, time: number, tag: string): PacketEnvelope {
  return { type, direction: 'SERVER', time, data: { tag } }
}

function readNdjsonGz(path: string): { data: { tag: string } }[] {
  const text = gunzipSync(readFileSync(path)).toString('utf8')
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe('SessionRecordingWriter', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'session-recorder-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes only allowlisted envelope types as NDJSON lines', async () => {
    const writer = new SessionRecordingWriter(dir)
    writer.writeBatch([
      env('UpdatePacket', 1000, 'kept-gameplay'),
      env('TextPacket', 1001, 'dropped-chat'),
      env('Hello', 1002, 'dropped-auth')
    ])
    await writer.close()

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const envelopes = readNdjsonGz(join(dir, files[0]))
    expect(envelopes.map((e) => e.data.tag)).toEqual(['kept-gameplay'])
  })

  it('keeps appending across what would be a bridge reconnect - no reset between writeBatch calls', async () => {
    const writer = new SessionRecordingWriter(dir)
    writer.writeBatch([env('UpdatePacket', 1000, 'before-reconnect')])
    // A reconnect only affects bridgeClient's onStatus callback - the
    // recorder itself has no notion of connection state, so batches arriving
    // after one just keep appending to the same file.
    writer.writeBatch([env('MapInfoPacket', 1500, 'instance-change')])
    writer.writeBatch([env('UpdatePacket', 2000, 'after-reconnect')])
    await writer.close()

    const files = readdirSync(dir)
    expect(files).toHaveLength(1)
    const envelopes = readNdjsonGz(join(dir, files[0]))
    expect(envelopes.map((e) => e.data.tag)).toEqual([
      'before-reconnect',
      'instance-change',
      'after-reconnect'
    ])
  })

  it('rotates to a new file once the current one passes the size threshold', async () => {
    const writer = new SessionRecordingWriter(dir, { rotateBytes: 200, retainFiles: 100 })
    for (let i = 0; i < 20; i++) {
      writer.writeBatch([env('UpdatePacket', 1000 + i, `padding-${i}-${'x'.repeat(40)}`)])
    }
    await writer.close()

    const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz'))
    expect(files.length).toBeGreaterThan(1)

    // Every envelope across every rotated file is still present, in order.
    const allTags = files
      .sort()
      .flatMap((f) => readNdjsonGz(join(dir, f)))
      .map((e) => e.data.tag)
    expect(allTags).toHaveLength(20)
    expect(allTags[0]).toBe('padding-0-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
  })

  it('keeps only the last N files, deleting older ones as rotation continues', async () => {
    const writer = new SessionRecordingWriter(dir, { rotateBytes: 50, retainFiles: 2 })
    for (let i = 0; i < 10; i++) {
      writer.writeBatch([env('UpdatePacket', 1000 + i, 'x'.repeat(60))])
    }
    await writer.close()

    const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz'))
    expect(files.length).toBeLessThanOrEqual(2)
  })

  it('close() cleanly finishes the gzip stream - the file is valid gzip readable immediately after', async () => {
    const writer = new SessionRecordingWriter(dir)
    writer.writeBatch([env('UpdatePacket', 1000, 'only-envelope')])
    await writer.close()

    const files = readdirSync(dir)
    expect(() => readNdjsonGz(join(dir, files[0]))).not.toThrow()
  })

  it('seeds retention from files already on disk, so a fresh writer prunes leftovers from a prior run', async () => {
    const stale = new SessionRecordingWriter(dir, { rotateBytes: 50, retainFiles: 5 })
    for (let i = 0; i < 5; i++) {
      stale.writeBatch([env('UpdatePacket', 1000 + i, 'x'.repeat(60))])
    }
    await stale.close()
    const leftoverCount = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz')).length
    expect(leftoverCount).toBeGreaterThan(2)

    // A brand-new writer instance (as happens on every app relaunch/toggle-on)
    // must inherit those leftovers into its own retention accounting instead
    // of starting blind and only ever pruning files it creates itself.
    const writer = new SessionRecordingWriter(dir, { retainFiles: 2 })
    await writer.close()

    const files = readdirSync(dir).filter((f) => f.endsWith('.ndjson.gz'))
    expect(files.length).toBeLessThanOrEqual(2) // seeded leftovers pruned down to retainFiles, same as any other rotation
  })
})
