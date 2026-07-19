import { afterEach, describe, expect, it, vi } from 'vitest'
import { DpsFeed } from '../src/renderer/src/dps/dpsFeed'
import { DpsTracker } from '../src/renderer/src/dps/DpsTracker'
import type { PacketEnvelope } from '../src/shared/ipc'

afterEach(() => {
  vi.useRealTimers()
})

function env(type: string, time: number, data: unknown): PacketEnvelope {
  return { type, direction: 'incoming', time, data } as PacketEnvelope
}

/**
 * PRD §3 (docs/prd-dps-graph.md): one shared DpsTracker serves both the live
 * panel and history retention. The hazard that used to force two separate
 * instances: `snapshot()` trims the rolling-window buffers in place, so a
 * live panel's periodic snapshot could truncate the whole-fight totals the
 * carry-forward/history fallback path reads. The cumulative-damage decoupling
 * makes that impossible - this test interleaves a trimming snapshot() call
 * mid-fight and asserts the retained history still carries the full totals.
 */
describe('shared DpsTracker (PRD §3)', () => {
  it('live snapshot() calls do not truncate carry-forward/history totals', () => {
    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    const tracker = new DpsTracker()

    const ingest = (e: PacketEnvelope): void => {
      vi.setSystemTime(e.time)
      tracker.ingest([e])
    }

    ingest(env('MapInfoPacket', t0, { displayName: 'Trim Dungeon' }))
    ingest(env('QuestObjectIdPacket', t0, { objectId: 900, list: [900] }))
    // Local player (id 1) engages the boss - arms the sticky lock.
    ingest(
      env('EnemyHitPacket', t0, {
        bulletId: 1,
        targetId: 900,
        shooterID: 1,
        kill: false,
        mainID: 1
      })
    )
    // No bridge `dps` envelopes in this scenario - forces the local-buffer
    // fallback path, the one that used to be trim-sensitive.
    ingest(env('DamagePacket', t0, { targetId: 900, damageAmount: 5000, objectId: 1, bulletId: 1 }))
    ingest(
      env('DamagePacket', t0 + 1000, {
        targetId: 900,
        damageAmount: 3000,
        objectId: 1,
        bulletId: 2
      })
    )

    // The live panel taking a snapshot much later trims phase 1's window
    // buffers in place (every hit is older than WINDOW_MS by now).
    vi.setSystemTime(t0 + 30_000)
    tracker.snapshot(t0 + 30_000)

    // Phase transition while phase 1 is still alive -> carry-forward reads the
    // whole-fight totals. With only the (just-trimmed) window buffers this
    // would carry 0; the cumulative map must still hold 8000.
    ingest(env('QuestObjectIdPacket', t0 + 30_000, { objectId: 901, list: [901] }))
    ingest(
      env('EnemyHitPacket', t0 + 39_000, {
        bulletId: 3,
        targetId: 901,
        shooterID: 1,
        kill: false,
        mainID: 1
      })
    )
    ingest(
      env('DamagePacket', t0 + 39_000, {
        targetId: 901,
        damageAmount: 2000,
        objectId: 1,
        bulletId: 3
      })
    )

    // Instance ends - the chain (phase 1 carry + phase 2 live) is retained.
    ingest(env('MapInfoPacket', t0 + 40_000, { displayName: 'Next Map' }))

    const history = tracker.getHistory()
    expect(history).toHaveLength(1)
    expect(history[0].enemies).toHaveLength(1)
    const row = history[0].enemies[0].players.find((p) => p.objectId === 1)
    expect(row?.damage).toBe(10_000)
  })

  it('DpsFeed notifies batch listeners only after the shared tracker ingested', () => {
    const feed = new DpsFeed()
    let historyLenAtNotify = -1
    feed.onBatch(() => {
      historyLenAtNotify = feed.tracker.getHistory().length
    })

    vi.useFakeTimers()
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)
    feed.ingest([
      env('MapInfoPacket', t0, { displayName: 'A' }),
      env('dps', t0, {
        enemies: [
          {
            id: 500,
            name: 'E',
            fightMs: 1000,
            players: [{ id: 1, name: 'p', damage: 9000, dps: 1 }]
          }
        ]
      })
    ])
    vi.setSystemTime(t0 + 1000)
    feed.ingest([env('MapInfoPacket', t0 + 1000, { displayName: 'B' })])

    // The second batch's MapInfo retained instance A - and because the
    // listener fires post-ingest, it observed that retention in the same
    // notification, not one batch late.
    expect(historyLenAtNotify).toBe(1)
  })
})
