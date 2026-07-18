import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

afterEach(() => {
  vi.useRealTimers()
})

describe('LootTracker capture replay', () => {
  it("soak #122: equipping/unequipping the local player's own gear creates no loot entries", () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    expect(tracker.entriesFor(6)).toEqual([])
    expect(tracker.entriesFor(8)).toEqual([])
  })

  it('soak #122 (mutated): a real bag-entity drop layered on the same session logs one entry', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const lastTime = envelopes[envelopes.length - 1].time
    // The real #122 capture never received a `lootBagTypes` envelope at all
    // (its 300-envelope ring had already rotated past the bridge's one-time
    // broadcast by the time the bug was reported), so this synthesizes one on
    // top of the real session, then a white-bag entity (objectType 3000,
    // registered here as bagType 6) carrying a tracked item in its first slot.
    // Wire shapes lifted from `bridge/LootBagTypes.java` and
    // `packets/data/enums/StatType.java` - no committed fixture actually
    // contains a real white/orange bag drop (see the fixtures README).
    const mutated = [
      ...envelopes,
      {
        type: 'lootBagTypes',
        direction: 'SERVER',
        time: lastTime + 500,
        data: {
          bagTypeTable: { '1001': 6 },
          lootBagIcons: { '6': 2000 },
          lootBagObjectTypes: { '3000': 6 },
          itemNames: { '1001': 'Potion of Life' }
        }
      },
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: lastTime + 1000,
        data: {
          newObjects: [
            {
              objectType: 3000,
              status: {
                objectId: 6000,
                stats: [{ statTypeNum: 8, statValue: 1001 }]
              }
            }
          ],
          drops: []
        }
      }
    ]
    const tracker = new LootTracker()

    replay(tracker, mutated)

    expect(tracker.entriesFor(6)).toHaveLength(1)
    expect(tracker.entriesFor(6)[0].objectType).toBe(1001)
    expect(tracker.entriesFor(8)).toEqual([])
  })

  it('soak #144: a bag seen before lootBagTypes arrives is recovered once metadata catches up', () => {
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-144-loot-empty.json.gz'))
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    const entries = tracker.entriesFor(6)
    expect(entries).toHaveLength(1)
    expect(entries[0].objectType).toBe(1001)
  })

  it('issue #193/#215: a shiny item is detected via the dedicated shinyItemTypes signal, not its (suffix-stripped) display name', () => {
    // Synthesized like the #122 (mutated) case above - no committed fixture
    // contains a real shiny drop. Wire shapes lifted from
    // `bridge/LootBagTypes.java` and `packets/data/enums/StatType.java`.
    // Soak #215: on real assets, `itemNames`' value for a shiny item is its
    // CLEAN display name (`IdToAsset.objectName` prefers the item's shared
    // `displayId` over the raw `" Shiny"`-suffixed id whenever one is set,
    // which is true for nearly every real shiny item) - so this fixture
    // deliberately gives the shiny item's `itemNames` entry no " Shiny"
    // suffix at all, matching the live client, and relies solely on
    // `shinyItemTypes` to flag it. A regression back to name-suffix
    // detection would fail this.
    const envelopes: Parameters<typeof replay>[1] = [
      {
        type: 'lootBagTypes',
        direction: 'SERVER',
        time: 1000,
        data: {
          bagTypeTable: { '1210': 6, '1001': 6 },
          lootBagIcons: { '6': 2000 },
          lootBagObjectTypes: { '3000': 6 },
          itemNames: { '1210': 'Dirk of Cronus', '1001': 'Potion of Life' },
          shinyItemTypes: [1210]
        }
      },
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: 1500,
        data: {
          newObjects: [
            {
              objectType: 3000,
              status: {
                objectId: 7000,
                stats: [
                  { statTypeNum: 8, statValue: 1210 },
                  { statTypeNum: 9, statValue: 1001 }
                ]
              }
            }
          ],
          drops: []
        }
      }
    ]
    const tracker = new LootTracker()

    replay(tracker, envelopes)

    const entries = tracker.entriesFor(6)
    expect(entries).toHaveLength(2)

    const shiny = entries.find((e) => e.objectType === 1210)
    const plain = entries.find((e) => e.objectType === 1001)
    expect(tracker.isShiny(shiny!.objectType)).toBe(true)
    expect(tracker.isShiny(plain!.objectType)).toBe(false)
  })

  it('issue #217: a wide-set tracker logs a drop from a non-6/8 bag with its slotType resolvable', () => {
    // Wire shape lifted from the widened bridge/LootBagTypes.java envelope -
    // bagType 7 (matching the real "The Hive Key" fact, slotType 10), not
    // white/orange, proving a caller-chosen tracked set (not just [6, 8])
    // both recognizes the bag entity and carries the item's slotType through.
    const envelopes: Parameters<typeof replay>[1] = [
      {
        type: 'lootBagTypes',
        direction: 'SERVER',
        time: 1000,
        data: {
          bagTypeTable: { '1001': 6, '2830': 7 },
          lootBagIcons: { '6': 2000 },
          lootBagObjectTypes: { '3000': 6, '4000': 7 },
          itemNames: { '1001': 'Potion of Life', '2830': 'The Hive Key' },
          slotTypes: { '2830': 10 }
        }
      },
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: 1500,
        data: {
          newObjects: [
            {
              objectType: 4000,
              status: {
                objectId: 8000,
                stats: [{ statTypeNum: 8, statValue: 2830 }]
              }
            }
          ],
          drops: []
        }
      }
    ]
    const wideTracker = new LootTracker([6, 7, 8])
    const narrowTracker = new LootTracker()

    replay([wideTracker, narrowTracker], envelopes)

    const wideEntries = wideTracker.entriesFor(7)
    expect(wideEntries).toHaveLength(1)
    expect(wideEntries[0].objectType).toBe(2830)
    expect(wideEntries[0].slotType).toBe(10)
    // A default (Loot panel) instance never tracks bagType 7 at all - the
    // Loot panel's own behavior is unchanged by this widening.
    expect(narrowTracker.entriesFor(7)).toEqual([])
  })

  it("issue #217: onEntry fires exactly once per newly-logged entry, including pendingNewObjects' replay", () => {
    // The bag arrives BEFORE lootBagTypes (the startup-race case §"Startup
    // race" in docs/overlay-renderer.md §7 covers), so this entry is only
    // logged once meta arrives and pendingNewObjects replays it - onEntry
    // must still fire exactly once for it, not zero and not twice.
    const envelopes: Parameters<typeof replay>[1] = [
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: 1000,
        data: {
          newObjects: [
            {
              objectType: 3000,
              status: {
                objectId: 9000,
                stats: [{ statTypeNum: 8, statValue: 1001 }]
              }
            }
          ],
          drops: []
        }
      },
      {
        type: 'lootBagTypes',
        direction: 'SERVER',
        time: 1500,
        data: {
          bagTypeTable: { '1001': 6 },
          lootBagIcons: { '6': 2000 },
          lootBagObjectTypes: { '3000': 6 },
          itemNames: { '1001': 'Potion of Life' }
        }
      }
    ]
    const tracker = new LootTracker()
    const seen: number[] = []
    const unsubscribe = tracker.onEntry((entry) => seen.push(entry.objectType))

    replay(tracker, envelopes)

    expect(seen).toEqual([1001])
    expect(tracker.entriesFor(6)).toHaveLength(1)

    unsubscribe()
    replay(tracker, [
      {
        type: 'UpdatePacket',
        direction: 'SERVER',
        time: 2000,
        data: {
          newObjects: [
            {
              objectType: 3000,
              status: { objectId: 9001, stats: [{ statTypeNum: 8, statValue: 1001 }] }
            }
          ],
          drops: []
        }
      }
    ])
    // Unsubscribed listener must not fire for a later entry.
    expect(seen).toEqual([1001])
    expect(tracker.entriesFor(6)).toHaveLength(2)
  })
})
