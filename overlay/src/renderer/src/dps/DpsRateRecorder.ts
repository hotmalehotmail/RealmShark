import type { BridgeDpsData } from './types'

/**
 * Time-binned damage-rate recorder (PRD §2, docs/prd-dps-graph.md). Fed by
 * delta-diffing the bridge's cumulative `{type:"dps"}` snapshots - the only
 * feed that includes the local player's reconstructed self-damage - it
 * maintains:
 *
 * - **the aggregate graph series**: the local player's summed damage deltas
 *   across all enemies, in `BIN_MS` bins over the trailing `GRAPH_WINDOW_MS`
 *   (the DPS panel sparkline's data);
 * - **per-(enemy, player) fold state**: O(1) running metrics (total observed
 *   damage, engaged span, peak trailing-average rate) for the detail panel's
 *   avg/peak columns. No per-player time series is retained anywhere.
 *
 * Owned by `DpsTracker` (fed from its `ingest()` `dps` case, reset with it),
 * so every consumer of the shared tracker sees one consistent recorder.
 */

/** One bin per bridge heartbeat interval (PacketBridge.DPS_INTERVAL_MS). */
export const BIN_MS = 250
/** The sparkline's x-range. */
export const GRAPH_WINDOW_MS = 10_000
/** Trailing-average window: the line's smoothing AND the "peak DPS" definition. */
export const SMOOTH_MS = 2_000

const GRAPH_BINS = GRAPH_WINDOW_MS / BIN_MS // 40
const SMOOTH_BINS = SMOOTH_MS / BIN_MS // 8
/** Extra slots so even the window's oldest point smooths over a full SMOOTH_BINS. */
const AGG_SLOTS = GRAPH_BINS + SMOOTH_BINS - 1

export interface DpsRateMetrics {
  /** Observed damage / engaged span - rate-while-engaged, floored at one bin (PRD §5). */
  avgDps: number
  /** Max trailing-SMOOTH_MS average observed, never reported below avgDps (see metricsFor). */
  peakDps: number
  /** Raw fold state, for carry-forward merging across boss phases. */
  damage: number
  engagedMs: number
}

export interface DpsGraphSeries {
  /** Trailing-averaged dps per bin, oldest → newest (GRAPH_BINS points). */
  points: number[]
  /** Max of `points` (0 when idle). */
  windowMax: number
  /** The newest point - the current smoothed dps. */
  current: number
  /**
   * The recorder's `curBin` this series was read at (bins close on time, not
   * on reads - see `advanceTo`). Multiple reads inside the same BIN_MS window
   * share this value; it only advances once per real bin tick, so consumers
   * that need to distinguish "a new bin closed" from "the same bin was
   * re-read" (e.g. the sparkline's slide animation) should key off this
   * instead of `points`' array identity, which changes on every read.
   */
  bin: number
}

interface KeyStats {
  damage: number
  firstBin: number
  lastBin: number
  /** Last SMOOTH_BINS bin deltas, slot = bin % SMOOTH_BINS; stale slots zeroed on advance. */
  ring: number[]
  ringBin: number
  peak: number
}

const SMOOTH_SECONDS = SMOOTH_MS / 1000

export class DpsRateRecorder {
  /** enemyId → playerId → last seen cumulative bridge damage total. */
  private baseline = new Map<number, Map<number, number>>()
  /** enemyId → playerId → running metrics fold. */
  private stats = new Map<number, Map<number, KeyStats>>()
  /** The local player's aggregate bin deltas, slot = bin % AGG_SLOTS. */
  private agg: number[] = new Array(AGG_SLOTS).fill(0)
  /** Global index (floor(time / BIN_MS)) of the newest bin written/advanced to; -1 = unstarted. */
  private curBin = -1

  /**
   * Advance the aggregate ring to the bin containing `timeMs`, zeroing the
   * slots for any bins skipped in between - bins close on time, not on
   * envelopes, so the series decays to zero when the stream goes quiet.
   * Called from every snapshot ingest and from every graph read.
   */
  advanceTo(timeMs: number): void {
    const bin = Math.floor(timeMs / BIN_MS)
    if (this.curBin === -1) {
      this.curBin = bin
      return
    }
    if (bin <= this.curBin) return
    const steps = Math.min(bin - this.curBin, AGG_SLOTS)
    for (let i = 1; i <= steps; i++) {
      this.agg[(((this.curBin + i) % AGG_SLOTS) + AGG_SLOTS) % AGG_SLOTS] = 0
    }
    this.curBin = bin
  }

  /**
   * Diff one bridge snapshot against the previous one and fold the deltas
   * into the current bin. Rules (PRD §2): first sight of a key only sets its
   * baseline (a mid-fight attach must not spike a bin with the whole
   * pre-attach total); a negative delta (bridge restart reset the engine's
   * totals) contributes nothing and re-baselines; a key absent from a
   * snapshot is "unchanged", never "went to zero".
   */
  onSnapshot(data: BridgeDpsData, timeMs: number, localPlayerId: number | null): void {
    this.advanceTo(timeMs)
    const bin = this.curBin
    for (const enemy of data.enemies ?? []) {
      let base = this.baseline.get(enemy.id)
      if (!base) {
        base = new Map()
        this.baseline.set(enemy.id, base)
      }
      for (const p of enemy.players ?? []) {
        if (!Number.isFinite(p.damage)) continue
        const prev = base.get(p.id)
        base.set(p.id, p.damage)
        if (prev === undefined) continue
        const delta = p.damage - prev
        if (delta <= 0) continue
        this.fold(enemy.id, p.id, delta, bin)
        if (localPlayerId !== null && p.id === localPlayerId) {
          this.agg[((bin % AGG_SLOTS) + AGG_SLOTS) % AGG_SLOTS] += delta
        }
      }
    }
  }

  private fold(enemyId: number, playerId: number, delta: number, bin: number): void {
    let byPlayer = this.stats.get(enemyId)
    if (!byPlayer) {
      byPlayer = new Map()
      this.stats.set(enemyId, byPlayer)
    }
    let s = byPlayer.get(playerId)
    if (!s) {
      s = {
        damage: 0,
        firstBin: bin,
        lastBin: bin,
        ring: new Array(SMOOTH_BINS).fill(0),
        ringBin: bin,
        peak: 0
      }
      byPlayer.set(playerId, s)
    }
    // Zero the ring slots for bins this key skipped since it last saw damage.
    const steps = Math.min(bin - s.ringBin, SMOOTH_BINS)
    for (let i = 1; i <= steps; i++) {
      s.ring[(((s.ringBin + i) % SMOOTH_BINS) + SMOOTH_BINS) % SMOOTH_BINS] = 0
    }
    s.ringBin = bin
    s.ring[((bin % SMOOTH_BINS) + SMOOTH_BINS) % SMOOTH_BINS] += delta
    s.damage += delta
    s.lastBin = bin
    // Evaluate the trailing average on every write: within a bin the sum only
    // grows, so the last evaluation before the ring advances captures the full
    // bin - a per-bin-close hook isn't needed.
    let trailing = 0
    for (const v of s.ring) trailing += v
    const rate = trailing / SMOOTH_SECONDS
    if (rate > s.peak) s.peak = rate
  }

  /**
   * Running avg/peak for one (enemy, player), or null before any observed
   * delta (e.g. the whole fight predated our attach - the UI renders "—"
   * rather than a fake 0). `peakDps` is floored at `avgDps`: for an
   * engagement shorter than SMOOTH_MS the trailing-window rate under-reads
   * (its denominator stays the full window), and "your peak was below your
   * average" is never a sane display.
   */
  metricsFor(enemyId: number, playerId: number): DpsRateMetrics | null {
    const s = this.stats.get(enemyId)?.get(playerId)
    if (!s || s.damage <= 0) return null
    const engagedMs = (s.lastBin - s.firstBin + 1) * BIN_MS
    const avgDps = s.damage / (engagedMs / 1000)
    return { avgDps, peakDps: Math.max(s.peak, avgDps), damage: s.damage, engagedMs }
  }

  /** The sparkline's data: GRAPH_BINS trailing-averaged points ending at `nowMs`'s bin. */
  graphSeries(nowMs: number): DpsGraphSeries {
    this.advanceTo(nowMs)
    const points: number[] = new Array(GRAPH_BINS)
    let windowMax = 0
    for (let i = 0; i < GRAPH_BINS; i++) {
      const endBin = this.curBin - (GRAPH_BINS - 1) + i
      let sum = 0
      for (let j = 0; j < SMOOTH_BINS; j++) {
        const bin = endBin - j
        // Bins before the recorder started (or beyond ring retention) read 0.
        if (bin < 0 || bin < this.curBin - (AGG_SLOTS - 1)) continue
        sum += this.agg[((bin % AGG_SLOTS) + AGG_SLOTS) % AGG_SLOTS]
      }
      const rate = sum / SMOOTH_SECONDS
      points[i] = rate
      if (rate > windowMax) windowMax = rate
    }
    return { points, windowMax, current: points[GRAPH_BINS - 1], bin: this.curBin }
  }

  /** Wipe everything - instance change / game closed. Same lifecycle as `DpsTracker.reset`. */
  resetInstance(): void {
    this.baseline.clear()
    this.stats.clear()
    this.agg.fill(0)
    this.curBin = -1
  }
}
