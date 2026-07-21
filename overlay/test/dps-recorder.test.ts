import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  BIN_MS,
  DpsRateRecorder,
  GRAPH_WINDOW_MS,
  SMOOTH_MS
} from '../src/renderer/src/dps/DpsRateRecorder'
import { DpsTracker } from '../src/renderer/src/dps/DpsTracker'
import type { BridgeDpsData } from '../src/renderer/src/dps/types'
import type { PacketEnvelope } from '../src/shared/ipc'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

afterEach(() => {
  vi.useRealTimers()
})

const LOCAL = 1
const t0 = 1_700_000_000_000

function snap(enemyId: number, damageByPlayer: Record<number, number>): BridgeDpsData {
  return {
    enemies: [
      {
        id: enemyId,
        name: 'E',
        fightMs: 1000,
        players: Object.entries(damageByPlayer).map(([id, damage]) => ({
          id: Number(id),
          name: `p${id}`,
          damage,
          dps: 0
        }))
      }
    ]
  }
}

function env(type: string, time: number, data: unknown): PacketEnvelope {
  return { type, direction: 'incoming', time, data } as PacketEnvelope
}

describe('DpsRateRecorder (PRD §2)', () => {
  it('first sight only baselines; subsequent growth becomes bin deltas', () => {
    const r = new DpsRateRecorder()
    // Mid-fight attach: a huge pre-existing total must not spike a bin.
    r.onSnapshot(snap(500, { [LOCAL]: 100_000 }), t0, LOCAL)
    expect(r.graphSeries(t0).windowMax).toBe(0)
    expect(r.metricsFor(500, LOCAL)).toBeNull()

    r.onSnapshot(snap(500, { [LOCAL]: 101_000 }), t0 + BIN_MS, LOCAL)
    const series = r.graphSeries(t0 + BIN_MS)
    // 1000 damage in the trailing SMOOTH_MS window.
    expect(series.current).toBeCloseTo(1000 / (SMOOTH_MS / 1000))
    expect(series.windowMax).toBe(series.current)
  })

  it('avg is rate-while-engaged floored at one bin; peak never reads below avg', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    // A one-bin burst: 1000 damage, engaged span = one bin (250ms).
    r.onSnapshot(snap(500, { [LOCAL]: 1000 }), t0 + BIN_MS, LOCAL)
    const m = r.metricsFor(500, LOCAL)
    expect(m).not.toBeNull()
    expect(m?.engagedMs).toBe(BIN_MS)
    expect(m?.avgDps).toBeCloseTo(1000 / (BIN_MS / 1000)) // 4000 - the honest burst rate, not 0
    expect(m?.peakDps).toBeCloseTo(m?.avgDps ?? 0) // trailing-window peak under-reads a short engagement; floored to avg
  })

  it('sustained fire: trailing average converges and peak >= avg', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    const perBin = 500
    const bins = 12
    for (let i = 1; i <= bins; i++) {
      r.onSnapshot(snap(500, { [LOCAL]: perBin * i }), t0 + i * BIN_MS, LOCAL)
    }
    const series = r.graphSeries(t0 + bins * BIN_MS)
    // A full SMOOTH_MS window of steady perBin damage per bin.
    expect(series.current).toBeCloseTo(((SMOOTH_MS / BIN_MS) * perBin) / (SMOOTH_MS / 1000)) // 2000
    const m = r.metricsFor(500, LOCAL)
    expect(m?.avgDps).toBeCloseTo((perBin * bins) / ((bins * BIN_MS) / 1000)) // 2000
    expect(m?.peakDps).toBeGreaterThanOrEqual(m?.avgDps ?? Infinity)
  })

  it('negative deltas (bridge restart) contribute nothing and re-baseline', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    r.onSnapshot(snap(500, { [LOCAL]: 5000 }), t0 + BIN_MS, LOCAL)
    // Bridge restarted mid-instance: totals reset below the baseline.
    r.onSnapshot(snap(500, { [LOCAL]: 100 }), t0 + 2 * BIN_MS, LOCAL)
    // Growth from the new baseline counts again.
    r.onSnapshot(snap(500, { [LOCAL]: 600 }), t0 + 3 * BIN_MS, LOCAL)
    const m = r.metricsFor(500, LOCAL)
    expect(m?.damage).toBe(5500) // 5000 + 500 - never a negative contribution
  })

  it('a key absent from a snapshot means unchanged, never zero', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    r.onSnapshot(snap(500, { [LOCAL]: 3000 }), t0 + BIN_MS, LOCAL)
    // A snapshot without enemy 500 at all (different enemy only).
    r.onSnapshot(snap(600, { [LOCAL]: 0 }), t0 + 2 * BIN_MS, LOCAL)
    // Enemy 500 reappears with the same total: no delta, no double count.
    r.onSnapshot(snap(500, { [LOCAL]: 3000 }), t0 + 3 * BIN_MS, LOCAL)
    expect(r.metricsFor(500, LOCAL)?.damage).toBe(3000)
  })

  it('the graph decays to zero when the stream goes quiet', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    r.onSnapshot(snap(500, { [LOCAL]: 4000 }), t0 + BIN_MS, LOCAL)
    expect(r.graphSeries(t0 + BIN_MS).windowMax).toBeGreaterThan(0)
    // Bins close on time, not on envelopes: a read a full window later finds
    // only zeros, with no envelope ever having "reported" the silence.
    const series = r.graphSeries(t0 + BIN_MS + GRAPH_WINDOW_MS + SMOOTH_MS)
    expect(series.windowMax).toBe(0)
    expect(series.current).toBe(0)
  })

  it('only the local player feeds the aggregate graph series', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0, 2: 0 }), t0, LOCAL)
    r.onSnapshot(snap(500, { [LOCAL]: 0, 2: 50_000 }), t0 + BIN_MS, LOCAL)
    expect(r.graphSeries(t0 + BIN_MS).windowMax).toBe(0) // teammate damage doesn't plot
    expect(r.metricsFor(500, 2)?.damage).toBe(50_000) // but their metrics still fold
  })

  it('graphSeries().bin only advances once per real bin tick, not once per read', () => {
    const r = new DpsRateRecorder()
    r.onSnapshot(snap(500, { [LOCAL]: 0 }), t0, LOCAL)
    r.onSnapshot(snap(500, { [LOCAL]: 1000 }), t0 + BIN_MS, LOCAL)
    // Several reads inside the same BIN_MS window (as a burst of coalesced
    // bridge envelopes would drive via useDpsGraph) share one bin - the
    // sparkline's slide effect keys off this to avoid re-triggering per read.
    const first = r.graphSeries(t0 + BIN_MS)
    const second = r.graphSeries(t0 + BIN_MS + 1)
    const third = r.graphSeries(t0 + BIN_MS + 40)
    expect(second.bin).toBe(first.bin)
    expect(third.bin).toBe(first.bin)
    // A read into the next bin window advances it exactly once.
    const next = r.graphSeries(t0 + 2 * BIN_MS)
    expect(next.bin).toBe(first.bin + 1)
  })
})

describe('recorder metrics through DpsTracker history (PRD §5)', () => {
  it('flat retained rows carry avg/peak from observed deltas', () => {
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    const tracker = new DpsTracker()
    tracker.ingest([
      env('MapInfoPacket', t0, { displayName: 'A' }),
      env('CreateSuccessPacket', t0, { objectId: LOCAL }),
      env('dps', t0, snap(500, { [LOCAL]: 0, 2: 0 })),
      env('dps', t0 + BIN_MS, snap(500, { [LOCAL]: 9000, 2: 6000 }))
    ])
    vi.setSystemTime(t0 + 1000)
    tracker.ingest([env('MapInfoPacket', t0 + 1000, { displayName: 'B' })])

    const rows = tracker.getHistory()[0].enemies[0].players
    const local = rows.find((r) => r.objectId === LOCAL)
    const mate = rows.find((r) => r.objectId === 2)
    expect(local?.avgDps).toBeCloseTo(9000 / (BIN_MS / 1000))
    expect(mate?.avgDps).toBeCloseTo(6000 / (BIN_MS / 1000))
    expect(local?.peakDps).toBeGreaterThanOrEqual(local?.avgDps ?? Infinity)
  })

  it('a phase chain merges damage, sums engaged spans, and keeps the max peak', () => {
    vi.useFakeTimers()
    vi.setSystemTime(t0)
    const tracker = new DpsTracker()
    tracker.ingest([
      env('MapInfoPacket', t0, { displayName: 'Boss Dungeon' }),
      env('CreateSuccessPacket', t0, { objectId: LOCAL }),
      env('QuestObjectIdPacket', t0, { objectId: 900, list: [900] }),
      env('EnemyHitPacket', t0, {
        bulletId: 1,
        targetId: 900,
        shooterID: LOCAL,
        kill: false,
        mainID: LOCAL
      }),
      env('dps', t0, snap(900, { [LOCAL]: 4000 })),
      env('dps', t0 + BIN_MS, snap(900, { [LOCAL]: 10_000 })),
      // Phase change while 900 is still alive -> carry-forward (with metrics).
      env('QuestObjectIdPacket', t0 + 2 * BIN_MS, { objectId: 901, list: [901] }),
      env('EnemyHitPacket', t0 + 2 * BIN_MS, {
        bulletId: 2,
        targetId: 901,
        shooterID: LOCAL,
        kill: false,
        mainID: LOCAL
      }),
      env('dps', t0 + 2 * BIN_MS, snap(901, { [LOCAL]: 2000 })),
      env('dps', t0 + 3 * BIN_MS, snap(901, { [LOCAL]: 5000 }))
    ])
    vi.setSystemTime(t0 + 1000)
    tracker.ingest([env('MapInfoPacket', t0 + 1000, { displayName: 'Next' })])

    const history = tracker.getHistory()
    expect(history[0].enemies).toHaveLength(1)
    const row = history[0].enemies[0].players.find((r) => r.objectId === LOCAL)
    // Carried phase-1 bridge total (10000) + live phase-2 bridge total (5000).
    expect(row?.damage).toBe(15_000)
    // One observed-delta bin per phase: 250ms + 250ms of engaged span.
    expect(row?.avgDps).toBeCloseTo(15_000 / ((2 * BIN_MS) / 1000))
    expect(row?.peakDps).toBeGreaterThanOrEqual(row?.avgDps ?? Infinity)
  })

  it('baseline-session replay: retained real-traffic rows get sane metrics', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'baseline-session.ndjson.gz'))
    const tracker = new DpsTracker()
    replay(tracker, envelopes)

    const rowsWithMetrics = tracker
      .getHistory()
      .flatMap((entry) => entry.enemies)
      .flatMap((enemy) => enemy.players)
      .filter((row) => row.avgDps !== undefined)
    expect(rowsWithMetrics.length).toBeGreaterThan(0)
    for (const row of rowsWithMetrics) {
      expect(row.avgDps).toBeGreaterThan(0)
      expect(row.peakDps).toBeGreaterThanOrEqual(row.avgDps ?? Infinity)
    }
  })
})
