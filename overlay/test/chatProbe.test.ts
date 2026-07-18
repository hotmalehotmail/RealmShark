import { describe, expect, it } from 'vitest'
import { CAPTURE_ALLOWED_TYPES } from '../src/shared/capture'
import { CHAT_PROBE_MAX_ENTRIES, CHAT_PROBE_TYPES, ChatProbeBuffer } from '../src/shared/chatProbe'
import type { PacketEnvelope } from '../src/shared/ipc'

function env(type: string, time = 0): PacketEnvelope {
  return { type, direction: 'SERVER', time, data: null }
}

describe('ChatProbeBuffer', () => {
  it('retains only probe-typed envelopes, in arrival order', () => {
    const buffer = new ChatProbeBuffer()
    buffer.push([
      env('UpdatePacket'),
      env('TextPacket', 1),
      env('NewTickPacket'),
      env('PartyListMessagePacket', 2),
      env('PlayerTextPacket', 3)
    ])
    const drained = buffer.drain()
    expect(drained.map((e) => e.type)).toEqual([
      'TextPacket',
      'PartyListMessagePacket',
      'PlayerTextPacket'
    ])
    expect(drained.map((e) => e.time)).toEqual([1, 2, 3])
  })

  it('drain empties the buffer', () => {
    const buffer = new ChatProbeBuffer()
    buffer.push([env('TextPacket')])
    expect(buffer.drain()).toHaveLength(1)
    expect(buffer.size).toBe(0)
    expect(buffer.drain()).toHaveLength(0)
  })

  it('evicts oldest beyond the cap', () => {
    const buffer = new ChatProbeBuffer()
    for (let i = 0; i < CHAT_PROBE_MAX_ENTRIES + 10; i++) {
      buffer.push([env('TextPacket', i)])
    }
    expect(buffer.size).toBe(CHAT_PROBE_MAX_ENTRIES)
    const drained = buffer.drain()
    expect(drained[0].time).toBe(10) // the 10 oldest were evicted
    expect(drained[drained.length - 1].time).toBe(CHAT_PROBE_MAX_ENTRIES + 9)
  })
})

describe('chat probe / capture allowlist separation', () => {
  /**
   * The privacy invariant behind the probe's existence (see the
   * CHAT_PROBE_TYPES doc comment): chat/party types are observable ONLY via
   * the explicitly-armed local probe, never via the shareable capture paths
   * (bug-report ring + session recorder, both filtered through
   * CAPTURE_ALLOWED_TYPES). If a type ever appears in both, either the
   * allowlist started leaking chat or the probe stopped being the isolated
   * path - both are bugs.
   */
  it('no probe type is capture-allowlisted', () => {
    const overlap = Array.from(CHAT_PROBE_TYPES).filter((type) => CAPTURE_ALLOWED_TYPES.has(type))
    expect(overlap).toEqual([])
  })
})
