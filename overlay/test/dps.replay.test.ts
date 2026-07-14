import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { DpsTracker } from '../src/renderer/src/dps/DpsTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(__dirname, 'fixtures/captures')

describe('DpsTracker capture replay', () => {
  it('soak #50 (other players’ damage missing): replays without throwing and returns a well-formed snapshot', () => {
    // Issue #50's root cause is Java-side (bridge.dps.DpsEngine attribution -
    // the TS tracker only *displays* the bridge's precomputed {type:"dps"}
    // envelopes, per PRD D4). This capture predates that fix and, per the
    // fixtures README, carries no {type:"dps"} or DamagePacket/EnemyHitPacket
    // envelopes at all - so replaying it through DpsTracker can't reproduce
    // the misattribution itself. What it CAN verify: the tracker survives
    // real (if incomplete) wire traffic from that era without throwing, and
    // still returns a well-formed snapshot. The actual #50 regression needs
    // the Phase 2 Java CaptureReplay mirror (docs/prd-agent-observability.md
    // §6.5) replaying this same fixture's precursor packets through
    // DpsEngine directly.
    const packets = loadCapture(join(FIXTURES_DIR, 'soak-50-dps-attribution.json.gz'))
    expect(packets.some((p) => p.type === 'dps' || p.type === 'DamagePacket')).toBe(false)

    const tracker = new DpsTracker()
    expect(() => replay(tracker, packets)).not.toThrow()

    const snapshot = tracker.snapshot(packets[packets.length - 1].time)
    expect(Array.isArray(snapshot.rows)).toBe(true)
  })
})
