import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

afterEach(() => {
  vi.useRealTimers()
})

describe('loadCapture() with a session recorder (.ndjson.gz) fixture', () => {
  it('parses one PacketEnvelope per NDJSON line, sorted by time', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'session-recording-sample.ndjson.gz'))

    expect(envelopes.map((e) => e.type)).toEqual(['MapInfoPacket', 'UpdatePacket', 'lootBagTypes'])
    expect(envelopes.every((e, i) => i === 0 || e.time >= envelopes[i - 1].time)).toBe(true)
  })

  it('replays into a tracker exactly like a .json.gz capture - a bag seen before lootBagTypes is recovered', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'session-recording-sample.ndjson.gz'))
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    const entries = tracker.entriesFor(6)
    expect(entries).toHaveLength(1)
    expect(entries[0].objectType).toBe(1001)
  })
})
