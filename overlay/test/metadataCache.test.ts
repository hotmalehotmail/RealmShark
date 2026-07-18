import { describe, expect, it } from 'vitest'
import { METADATA_ENVELOPE_TYPES, type PacketEnvelope } from '../src/shared/ipc'
import { LatestMetadataCache } from '../src/shared/metadataCache'

function env(type: string, time: number): PacketEnvelope {
  return { type, direction: 'internal', time, data: { metaVersion: `t${time}` } }
}

/**
 * Issue #245: with edge-triggered metadata delivery (#239), a renderer
 * consumer that subscribes after the one-shot delivery needs main's cached
 * copy - this cache is what `IPC.replayMetadata` re-sends.
 */
describe('LatestMetadataCache', () => {
  it('keeps exactly the latest envelope per metadata type', () => {
    const cache = new LatestMetadataCache()
    cache.push(env('lootBagTypes', 1))
    cache.push(env('itemInfo', 2))
    cache.push(env('lootBagTypes', 3))

    const snapshot = cache.snapshot()
    expect(snapshot).toHaveLength(2)
    expect(snapshot.find((e) => e.type === 'lootBagTypes')?.time).toBe(3)
    expect(snapshot.find((e) => e.type === 'itemInfo')?.time).toBe(2)
  })

  it('ignores non-metadata envelope types', () => {
    const cache = new LatestMetadataCache()
    cache.push(env('UpdatePacket', 1))
    cache.push(env('dps', 2))
    cache.push(env('TextPacket', 3))
    expect(cache.snapshot()).toEqual([])
  })

  it('covers every declared metadata type and starts empty', () => {
    const cache = new LatestMetadataCache()
    expect(cache.snapshot()).toEqual([])
    for (const [i, type] of METADATA_ENVELOPE_TYPES.entries()) cache.push(env(type, i))
    expect(cache.snapshot().map((e) => e.type)).toEqual([...METADATA_ENVELOPE_TYPES])
  })
})
