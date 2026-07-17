import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

afterEach(() => {
  vi.useRealTimers()
})

/**
 * Smoke + wire-reality pins over the kitchen-sink seed corpus (PRD §7.3 /
 * D5): `baseline-session.ndjson.gz`, a verbatim ~8-minute slice of a real
 * maintainer session (2026-07-16, nexus/vault/pet-yard churn - see the
 * fixtures README for provenance and known coverage gaps). Its first job is
 * documentation: an agent asking "what does a real X look like on the wire"
 * greps this fixture instead of guessing. The assertions below pin the facts
 * a guess would most plausibly get wrong, so a corpus regeneration that
 * loses them fails here rather than silently degrading the reference.
 */
describe('baseline-session seed corpus', () => {
  const envelopes = loadCapture(join(FIXTURES_DIR, 'baseline-session.ndjson.gz'))

  it('is a real-sized, chronologically sorted session slice', () => {
    expect(envelopes.length).toBeGreaterThan(20_000)
    expect(envelopes.every((e, i) => i === 0 || e.time >= envelopes[i - 1].time)).toBe(true)
    // Instance churn is the point of this slice: nexus/vault/pet-yard hops.
    const mapInfos = envelopes.filter((e) => e.type === 'MapInfoPacket')
    expect(mapInfos.length).toBeGreaterThanOrEqual(10)
  })

  it('pins wire reality: MapInfo displayName is a RAW localization key, name is resolved', () => {
    // The {s.rotmg}-class fact (soak #89): the wire carries the unresolved
    // "{s.nexus}" in displayName; the human-readable string lives in `name`.
    // A consumer rendering displayName verbatim shows braces to the user.
    const nexus = envelopes.find(
      (e) => e.type === 'MapInfoPacket' && (e.data as { name?: string }).name === 'Nexus'
    )
    expect(nexus).toBeDefined()
    expect((nexus!.data as { displayName?: string }).displayName).toBe('{s.nexus}')
  })

  it('carries a real multiplayer roster (NAME_STAT strings from live players)', () => {
    const names = new Set<string>()
    for (const e of envelopes) {
      if (e.type !== 'UpdatePacket') continue
      const data = e.data as {
        newObjects?: { status?: { stats?: { statType?: string; stringStatValue?: string }[] } }[]
      }
      for (const o of data.newObjects ?? [])
        for (const s of o.status?.stats ?? [])
          if (s.statType === 'NAME_STAT' && s.stringStatValue) names.add(s.stringStatValue)
    }
    expect(names.size).toBeGreaterThan(200)
  })

  it('replays through the loot tracker; contains bag-entity drops but no tracked white/orange', () => {
    // Ground truth for this session: brown (1280) and soulbound (1283) bags
    // dropped, but no white/orange - so the tracked-color panels must stay
    // empty. (White/orange recognition is covered by the soak-144 fixture.)
    const bagDrops = new Set<number>()
    for (const e of envelopes) {
      if (e.type !== 'UpdatePacket') continue
      const data = e.data as { newObjects?: { objectType?: number }[] }
      for (const o of data.newObjects ?? [])
        if (o.objectType !== undefined && o.objectType >= 1280 && o.objectType <= 1296)
          bagDrops.add(o.objectType)
    }
    expect(bagDrops.has(1280)).toBe(true)

    const tracker = new LootTracker()
    replay(tracker, envelopes) // must not throw across 24k real envelopes
    expect(tracker.entriesFor(6)).toHaveLength(0)
    expect(tracker.entriesFor(8)).toHaveLength(0)
  })
})
