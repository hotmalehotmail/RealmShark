# PRD: DPS trend graph + peak/average DPS metrics

**Status:** design accepted, not yet implemented
**Scope:** overlay renderer only, plus a `FakePacketSource` extension (dev tooling —
no production bridge/Java changes)
**Implementation plan:** §9 — four dependency-ordered issues for the agent dev-loop

Give the player a live view of how their damage output is trending over the last
~10 seconds (a small sparkline in the DPS panel), and give the DPS detail panel
honest per-player **average** and **peak** DPS numbers — replacing the displayed
bridge `dps` quotient, which is the surface of a real observed bug (per-player dps
rendering as 0; diagnosis in §1).

Decisions locked in with the maintainer:

- **Graph scope: aggregate.** The line is the local player's damage summed across
  **all** targets, not per-target. (Per-target series in RotMG are dominated by
  trash that dies in under two seconds; the storage design below still bins
  per-target, so a per-target view stays a cheap later toggle — see §8.)
- **Smoothing: trailing average.** Each plotted point is a short trailing-window
  average, not a raw per-bin rate (raw bins are spiky at RotMG shot cadence). The
  same smoothing window defines "peak DPS" so the metric matches the line's
  visible high point.
- **Data source: delta-diffing the bridge's `{type:"dps"}` snapshots.** The raw
  packet stream cannot see the local player's own damage (a passive sniffer never
  receives it — see `docs/dps-engine.md`); the bridge's cumulative snapshots are
  the only feed that includes the reconstructed self-damage, and they already
  arrive at a graph-friendly cadence (250 ms heartbeat, 50 ms-coalesced damage
  pushes — `PacketBridge.java`).
- **No graphs for other players.** Scrapped: no per-player time *series* is
  retained anywhere. Other players still get the O(1) peak/avg *metrics* (§5) —
  those need a running fold, not a stored series.
- **Detail panel shows renderer-computed avg + peak per player**, and stops
  displaying the bridge `dps` field (the field stays on the wire and in the TS
  types; only the display changes).
- **One shared `DpsTracker`.** The two-instance pattern (live panel +
  `useDpsHistory`) is consolidated first, as its own behavior-preserving slice
  (§3), so the recorder has a single ingest path to hang off.

---

## 1. Background — the "dps is always 0" bug this also fixes

The detail panel's per-player row currently displays the bridge's `dps` field:
`damage / fightSec`, computed in `DpsBroadcaster.snapshotJson()` with
`fightSec = (lastDamageTaken − firstDamageTaken) / 1000`. Investigation (fake-mode
wire probe, the committed `baseline-session` capture, and full-capture replay
through `DpsTracker`) showed the pipeline is healthy end-to-end — frozen history
rows retain nonzero dps in every replayable path — but found **two structural
zero-producers**, both real:

1. **Tick quantization / burst kills (bridge-side).** The engine's clock
   (`DpsEngine.timePc`) only advances when a `NewTickPacket` is processed
   (~200 ms), and both damage timestamps are stamped from it. Any enemy whose
   entire damage window fits inside one tick reports `fightMs == 0` → `dps = 0`
   **for every attacker**, while `damage` reads fine. In the baseline capture all
   ~3% zero-dps rows are exactly the `fightMs == 0` enemies. Fast-dying realm
   content makes this common.
2. **Carry-forward discards dps (renderer-side).** `DpsTracker.bossCarry` stores
   only `{name, damage}`; `bossSnapshot()` emits carried rows with `dps: 0`, and a
   row only regains a dps value if that player also has live bridge rows on the
   *current* phase objectId. A quest boss that dies out of the local client's view
   never emits `drops`, so `bossAlive` stays true and each objective change folds
   the whole encounter into carry — a retained Realm entry's merged boss row can
   show `dps = 0` for **everyone**.

Both zeros disappear as a *display* problem once the detail panel shows the §5
metrics instead: the recorder's engaged-duration denominator is floored at one bin
(a burst kill shows its true, large rate instead of 0), and the carry struct is
extended to carry the metrics across phases instead of dropping them. No bridge
change is needed (§8).

## 2. The recorder — `DpsRateRecorder`

A plain-TS module owned by the shared `DpsTracker` (§3), fed from the existing
`ingest()` switch — no new consumed envelope types, so `CONSUMED_ENVELOPE_TYPES`
and the capture-allowlist tripwire are untouched.

### Constants

```ts
const BIN_MS = 250          // one bin per bridge heartbeat interval
const GRAPH_WINDOW_MS = 10_000   // the sparkline's x-range (40 bins)
const SMOOTH_MS = 2_000     // trailing-average window: the line's smoothing AND the "peak" definition (8 bins)
```

### Delta-diffing

On every `dps` envelope, for each `(enemyId, playerId)` row, compute
`delta = damage(now) − damage(prev)` against the previously seen snapshot and add
it to the current time bin. Rules:

- **Clamp at ≥ 0 and re-baseline.** A negative delta (bridge restart mid-instance
  resets the engine's totals) contributes nothing and resets that key's baseline
  to the new value. Never emit negative damage.
- **Absence is not a delta.** An enemy or player missing from a snapshot means
  "unchanged", never "went to zero". (In practice the bridge keeps dead enemies in
  `entityHitList` until the `MapInfoPacket` clear and never sends an empty
  snapshot, so absence is rare — but the rule must hold.)
- **Bins close on time, not on envelopes.** The render tick (§4) advances/closes
  bins, so the line decays to zero when the stream goes quiet (WS drop, combat
  lull) instead of freezing at its last value.

### What is stored

- **The aggregate series (the graph):** one ring buffer of 40 bins — the local
  player's summed deltas across all enemies. Local-player identity comes from the
  tracker's existing dual-source resolution (`CreateSuccessPacket` +
  `EnemyHitPacket.mainID`); until it resolves, the graph renders its empty state.
- **Per-`(enemyId, playerId)` fold state (the metrics):** total damage, first/last
  bin index with a positive delta, an `SMOOTH_MS`-sized (8-slot) mini-ring of
  recent bin deltas, and a running `peak` = max trailing-`SMOOTH_MS` average
  observed at any bin close. All O(1) per key — **no series is retained**.
  Cardinality is bounded by what the bridge itself tracks (the same rows as
  `bridgeEnemies`), and everything clears on the instance reset.

### Reset semantics

Same lifecycle as the tracker: wiped on `MapInfoPacket` (after retention — §5
freezes metrics into the history entry first, matching the existing
`retainInstanceIfQualifying()` → `reset()` order) and on overlay `detach`.

## 3. One tracker instead of two (prerequisite refactor)

Today two full `DpsTracker` instances each ingest every batch: the live panel's
(`useDpsTracker`) and the history hook's (`useDpsHistory`). The separation is
load-bearing, not accidental: `snapshot()` **trims the rolling-window buffers in
place** (`buffer.shift()`), so sharing one instance today would let the live
panel's 1 Hz snapshot silently truncate the history tracker's fallback damage
totals.

The refactor removes that hazard so one instance can serve everything:

- Decouple **cumulative per-attacker totals** (what history/carry need) from the
  **8 s windowed buffers** (what the live fallback rate needs): keep a running
  cumulative sum per `(target, attacker)` alongside the window buffer, so trimming
  the window can never lose fight-total information.
- One shared tracker instance (module-level, exposed via context the same way
  `dpsDetailContext` works); `useDpsTracker` and `useDpsHistory` become views over
  it. `PanelFrame` keeping panels mounted for the app's whole session (the
  retention argument in `useDpsHistory`'s doc comment) holds unchanged — ingest
  moves to a single App-level owner.
- **No visible behavior change.** The existing vitest replay suite must pass
  unchanged, plus a new regression: interleaving live `snapshot()` calls during a
  replay must not alter the retained history entry (the exact hazard that forced
  two instances).

## 4. The glance graph (DPS panel sparkline)

A small trend line in `DpsPanel`, above/below the existing rows, showing the §2
aggregate series smoothed with the trailing `SMOOTH_MS` average.

Rendering rules (game-overlay constraints first):

- **Bare inline SVG** — one `<polyline>`/`<path>` over ~40 points plus a soft area
  fill. No chart library, no axes, no gridlines, no legend (single series — the
  panel context names it).
- **2 px line** in the overlay's existing `accent` token; area fill is the same
  hue at low alpha. All text (the value label) wears the panel's normal text
  tokens, never the series color.
- **One direct label:** the current smoothed DPS value, rendered as text at the
  line's right edge — the sparkline's only number. No per-point labels, no
  tooltip in v1 (the overlay is click-through during play, so hover is
  unreachable; revisit only if the panel gains interactive affordances).
- **Y-domain** `[0, windowMax × 1.1]`, rescaled at most once per bin tick so the
  line doesn't judder; baseline pinned at 0.
- **Discrete updates at bin cadence** (one re-render per 250 ms tick, driven by
  the existing update paths) — no CSS transitions, no rAF animation loops. This
  window composites over a game; steady-state GPU repaints must stay bounded.
- **Panel sizes:** shown at `md`/`lg`; hidden at `sm` (the compact glance layout
  has no room — matches `showHeader`'s existing size gating).
- Empty state (no local player resolved / no damage in window): flat baseline,
  no value label.

Screenshots: the PR regenerates the committed panel gallery (`npm run shots`);
the review agent's visual pass applies. `ui:signoff` on the issue is the
maintainer's call at labeling time.

## 5. Detail-panel metrics — average + peak per player

Displayed in each expanded per-player row of `DpsDetailPanel`, replacing the
current `{formatDps(row.dps)} dps` span:

```
<damage>  <pct>%   avg <avgDps> · peak <peakDps>
```

Definitions (all from the §2 fold state, per `(enemy, player)`):

- **`avgDps` = totalDamage / engagedMs**, where
  `engagedMs = (lastBin − firstBin + 1) × BIN_MS` — the span in which that player
  was actually damaging that enemy, **floored at one bin**. This is deliberately
  rate-while-engaged, not damage-over-fight-length: it is what makes a
  one-tick burst kill show its true (large) rate instead of the bridge's 0 (§1.1).
- **`peakDps`** = the running max of the trailing-`SMOOTH_MS` average — the same
  smoothing as the graph, so "peak" is the number the line visibly touched.

Plumbing:

- History rows (`PlayerDps` as retained in `DpsHistoryEnemy`) gain optional
  `avgDps`/`peakDps`, frozen at retention time from the recorder — the same
  freeze-at-instance-end pattern as cosmetics.
- **The carry struct is extended**: `bossCarry` entries become
  `{name, damage, engagedMs, peak}`. Merging a phase into carry sums `damage` and
  `engagedMs` and takes `max(peak)`; the merged row's `avgDps` is recomputed as
  summed damage / summed engagedMs. This closes §1.2 — a Realm boss chain's
  carried rows keep honest rates.
- The recorder and the bridge rows agree by construction (both derive from the
  same snapshots), so a row's `damage` and its `avgDps` numerator can't drift.
- Rows with no recorder data (the bridge-absent fallback path — effectively never,
  since the bridge is bundled and supervised) render `—` for both metrics rather
  than a fake 0.

The live `DpsList` dps column is **out of scope** (§8) — it keeps showing the
bridge field for now.

## 6. FakePacketSource extension (dev tooling)

The fake source already produces flowing `dps` snapshots (two fake enemies +
periodic `MapInfoPacket` resets), which exercises the recorder and the graph. It
does **not** emit `QuestObjectIdPacket`, so the §5 carry-merge path is invisible
in dev. Per the repo rule (extend `FakePacketSource` rather than hand-rolling
fakes elsewhere), the metrics slice adds: a periodic quest-objective cycle that
marks one fake enemy as the objective and later re-points to the other while the
first is still alive (a synthetic "phase change"), exercising
`carryForwardBossDamage` + the extended carry struct end-to-end on macOS.

## 7. Testing

- **Recorder unit tests** (vitest, fake timers): delta extraction from synthetic
  `dps` envelopes; negative-delta clamp + re-baseline; absence ≠ zero; bin decay
  when the stream goes quiet; engaged-duration floor; peak = max trailing average.
- **Replay tests** over `baseline-session.ndjson.gz`: retained metrics are sane on
  real traffic (`peakDps ≥ avgDps > 0` for sustained fights; the capture's
  `fightMs == 0` burst-kill enemies — the §1.1 rows — get **nonzero** `avgDps`).
- **Consolidation regression** (§3): existing suite green + the
  snapshot-doesn't-perturb-history test.
- **No allowlist churn**: the recorder consumes only already-declared envelope
  types; the tripwire test must not need touching.
- **Gallery**: `npm run shots` regenerated in the sparkline PR.

## 8. Non-goals (v1)

- Per-target graph views or a target toggle (storage permits it later; no UI now).
- Time-series graphs for other players (explicitly scrapped).
- Changing the live `DpsList` dps column (candidate follow-up: switch it to the
  recorder's rolling rate).
- Bridge-side changes — including a `fightSec` floor for the wire `dps` field.
  The field becomes display-dead in the overlay; other consumers keep the
  existing semantics.
- Sparkline tooltips/crosshair (unreachable in click-through play).
- Persisting series or metrics across app sessions.

## 9. Implementation plan

Four dependency-ordered issues, each one agent PR into `staging`, implementable
and testable headless (FakePacketSource + vitest, no game):

1. **Tracker consolidation** — §3 exactly: cumulative totals decoupled from window
   buffers, one shared instance, hooks become views, no visible behavior change,
   regression test included.
2. **Recorder + metrics core (no UI)** — `DpsRateRecorder`, aggregate series,
   per-`(enemy, player)` fold state, extended carry struct, history freezing of
   `avgDps`/`peakDps`, the §6 FakePacketSource quest-objective cycle, unit +
   replay tests. Ships nothing visible.
3. **DPS panel sparkline** — §4 over the aggregate series; gallery regenerated.
4. **Detail-panel avg/peak display** — §5's row change, `—` fallback, gallery
   regenerated. This is the slice that closes the observed "dps always 0" bug.

Label them (`agent:build`) **sequentially, each after the previous PR lands** —
each slice builds on the previous one's contract. This PRD must be merged (on
`staging`, where build agents branch from) before the first label is applied.

## Cross-references

- `docs/dps-engine.md` — the bridge snapshot's cumulative semantics and the
  self-damage reconstruction that makes it the only viable graph feed.
- `docs/overlay-renderer.md` — `DpsTracker`, focus/carry logic, panel system.
  §§2–5 of this PRD change what that doc describes; each implementation PR updates
  it in the same change.
- `docs/overlay-testing.md` — the replay harness the §7 tests build on.
