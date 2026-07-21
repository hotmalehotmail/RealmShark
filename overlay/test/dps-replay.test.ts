import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DpsTracker } from '../src/renderer/src/dps/DpsTracker'
import type { PlayerDps } from '../src/renderer/src/dps/types'
import { loadCapture, replay, replayUntil } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

const totalDamage = (rows: PlayerDps[]): number => rows.reduce((sum, r) => sum + r.damage, 0)

afterEach(() => {
  vi.useRealTimers()
})

describe('DpsTracker capture replay', () => {
  it("soak #50: a non-local player's damage is not missing from the DPS list", () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-50-other-player-damage.json.gz'))
    const tracker = new DpsTracker()

    replay(tracker, envelopes)

    const snapshot = tracker.snapshot(Date.now())
    expect(snapshot.targetId).toBe(900)
    expect(snapshot.rows).toHaveLength(2)
    const byId = new Map(snapshot.rows.map((r) => [r.objectId, r]))
    expect(byId.get(100)).toMatchObject({ name: 'LocalHero', damage: 5000 })
    expect(byId.get(200)).toMatchObject({ name: 'OtherHero', damage: 8000 })
  })
})

// Regression for the bug where, in the open-world Realm, killing a quest boss
// rolled its whole damage total onto the *next* quest boss and snapped the DPS
// label to it instantly. Root cause: the next boss's QuestObjectIdPacket is
// processed in the same server tick as, but *before*, the UpdatePacket that
// despawns the just-killed boss, so `bossAlive` was still true and the tracker
// mis-classified an independent Realm boss-swap as a phase change (carry). The
// fixture reproduces exactly that packet ordering (see gen at scratchpad /
// docs/overlay-renderer.md §5). The fix gates carry-forward on NOT being in the
// Realm; these two cases pin both sides of that gate.
describe('DpsTracker Realm boss-swap rollover (regression)', () => {
  const REALM_FIXTURE = join(FIXTURES_DIR, 'realm-boss-rollover.json.gz')

  it('does not carry a killed Realm boss onto the next quest boss, and holds the label on the dead boss until the next is hit', () => {
    const envelopes = loadCapture(REALM_FIXTURE)

    // Right after the quest marker jumps to Boss B, before the player hits it:
    // focus must stay on the just-killed Boss A with only its own damage.
    const afterSwap = new DpsTracker()
    replayUntil(afterSwap, envelopes, 1_002_100)
    const swap = afterSwap.snapshot(1_002_100)
    expect(swap.targetId).toBe(900)
    expect(swap.targetName).toBe('Possessed Pumpkin')
    const byId = new Map(swap.rows.map((r) => [r.objectId, r]))
    expect(byId.get(100)?.damage).toBe(6000)
    expect(byId.get(200)?.damage).toBe(4000)
    expect(totalDamage(swap.rows)).toBe(10000)

    // Once the player actually hits Boss B, focus moves to it - showing ONLY
    // Boss B's damage (2500), never Boss A's carried 10000.
    const afterHitB = new DpsTracker()
    replayUntil(afterHitB, envelopes, 1_003_000)
    const b = afterHitB.snapshot(1_003_000)
    expect(b.targetId).toBe(901)
    expect(b.targetName).toBe('Legion Excavator')
    expect(totalDamage(b.rows)).toBe(2500)
  })

  it('still carries damage forward across a phase change OUTSIDE the Realm (dungeon multi-phase boss unchanged)', () => {
    // Same packet sequence, but the instance is a dungeon (no Realm signals):
    // the bossAlive gate then treats the objectId change as a genuine phase
    // change and carries Boss A's damage into the merged total, as before.
    const envelopes = loadCapture(REALM_FIXTURE).map((e) =>
      e.type === 'MapInfoPacket'
        ? {
            ...e,
            data: {
              name: 'Sanctuary',
              displayName: "Oryx's Sanctuary",
              maxRealmScore: -1,
              currentRealmScore: -1
            }
          }
        : e
    )

    const afterSwap = new DpsTracker()
    replayUntil(afterSwap, envelopes, 1_002_100)
    const swap = afterSwap.snapshot(1_002_100)
    expect(swap.targetId).toBe(901) // focus snaps straight to the new phase
    expect(totalDamage(swap.rows)).toBe(10000) // Boss A's damage carried forward

    const afterHitB = new DpsTracker()
    replayUntil(afterHitB, envelopes, 1_003_000)
    const merged = afterHitB.snapshot(1_003_000)
    expect(merged.targetId).toBe(901)
    expect(totalDamage(merged.rows)).toBe(12500) // carried 10000 + live 2500
  })
})
