import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

afterEach(() => {
  vi.useRealTimers()
})

describe('LootTracker capture replay', () => {
  it("soak #122: equipping/unequipping the local player's own gear creates no loot entries", () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    expect(tracker.entriesFor(6)).toEqual([])
    expect(tracker.entriesFor(8)).toEqual([])
  })

  it('soak #122 (mutated): a real bag-entity drop layered on the same session logs one entry', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const lastTime = envelopes[envelopes.length - 1].time
    // Synthesize a true drop on top of the equip/unequip-only session: a
    // white-bag entity (objectType 3000, registered in the fixture's
    // lootBagTypes envelope as bagType 6) appearing with a tracked item in
    // its first slot.
    const mutated = [
      ...envelopes,
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: lastTime + 1000,
        data: {
          newObjects: [
            {
              objectType: 3000,
              status: {
                objectId: 6000,
                stats: [{ statTypeNum: 8, statValue: 1001 }]
              }
            }
          ],
          drops: []
        }
      }
    ]
    const tracker = new LootTracker()

    replay(tracker, mutated)

    expect(tracker.entriesFor(6)).toHaveLength(1)
    expect(tracker.entriesFor(6)[0].objectType).toBe(1001)
    expect(tracker.entriesFor(8)).toEqual([])
  })

  it('soak #144: a bag seen before lootBagTypes arrives is recovered once metadata catches up', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-144-loot-empty.json.gz'))
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    const entries = tracker.entriesFor(6)
    expect(entries).toHaveLength(1)
    expect(entries[0].objectType).toBe(1001)
  })
})
