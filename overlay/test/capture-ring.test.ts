import { describe, expect, it } from 'vitest'
import { CaptureRing } from '../src/shared/capture'
import type { PacketEnvelope } from '../src/shared/ipc'

function env(type: string, time: number, tag: string): PacketEnvelope {
  return { type, direction: 'incoming', time, data: { tag } }
}

describe('CaptureRing.snapshot() ordering', () => {
  it('keeps true push order for same-timestamp envelopes split across the shared and a quota sub-buffer', () => {
    // Reproduces the exact pair LootTracker depends on: a same-ms
    // UpdatePacket (shared, no quota) and NewTickPacket (quota'd) arriving
    // in that order. A time-only sort would put every shared-buffer entry
    // before every quota-buffer entry regardless of real arrival order,
    // since Array.prototype.sort's stability then falls back to push order
    // in the concatenated [...sharedBuffer, ...quotaBuffers] array.
    const ring = new CaptureRing()
    ring.push(env('UpdatePacket', 1000, 'first'))
    ring.push(env('NewTickPacket', 1000, 'second'))
    ring.push(env('UpdatePacket', 1000, 'third'))

    const tags = ring.snapshot().map((e) => (e.data as { tag: string }).tag)
    expect(tags).toEqual(['first', 'second', 'third'])
  })

  it('reverses that order correctly when the quota-buffer envelope truly arrives first', () => {
    const ring = new CaptureRing()
    ring.push(env('NewTickPacket', 2000, 'first'))
    ring.push(env('UpdatePacket', 2000, 'second'))

    const tags = ring.snapshot().map((e) => (e.data as { tag: string }).tag)
    expect(tags).toEqual(['first', 'second'])
  })

  it('still sorts primarily by time across non-tied envelopes', () => {
    const ring = new CaptureRing()
    ring.push(env('UpdatePacket', 3000, 'later'))
    ring.push(env('NewTickPacket', 1000, 'earlier'))

    const tags = ring.snapshot().map((e) => (e.data as { tag: string }).tag)
    expect(tags).toEqual(['earlier', 'later'])
  })
})
