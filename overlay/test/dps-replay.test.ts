import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DpsTracker } from '../src/renderer/src/dps/DpsTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

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
