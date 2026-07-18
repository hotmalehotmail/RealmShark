import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AlertEngine } from '../src/renderer/src/alerts/AlertEngine'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/captures')

/**
 * Decodes (per `sprites/enchantRarity.ts`'s port of
 * `bridge.dps.PcStatsDecoder`) to exactly 4 filled enchant ids -> rarity/
 * enchantCount 4 (divine). Bytes: 1 header + type=1026 (LE) + four
 * arbitrary non-negative int16 enchant ids, base64-encoded with '+'/'/'
 * swapped for '-'/'_' (the decoder's six-bit charset is exactly base64url).
 */
const FOUR_ENCHANT_CODE = 'AAIEZABlAGYAZwA='

afterEach(() => {
  vi.useRealTimers()
})

describe('AlertEngine capture replay (issue #218)', () => {
  it('a white-bag drop layered on the soak #122 capture fires whiteBag (+ enchantedDrop when divine)', () => {
    // The real #122 capture never contains an actual white/orange bag drop
    // (see loot-replay.test.ts's identical technique) - this layers a
    // synthetic lootBagTypes + UpdatePacket pair on top of a real session,
    // giving the dropped item a 4-enchant code so it also qualifies for the
    // default (divine, tier 4) enchantedDrop rule.
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const lastTime = envelopes[envelopes.length - 1].time
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
                stats: [
                  { statTypeNum: 8, statValue: 1001 },
                  { statTypeNum: 80, stringStatValue: FOUR_ENCHANT_CODE }
                ]
              }
            }
          ],
          drops: []
        }
      }
    ]
    const engine = new AlertEngine()

    replay(engine, mutated)

    const alerts = engine.store.getAll()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].matchedKindIds).toEqual(['whiteBag', 'enchantedDrop'])
  })

  it('soak #237: walking away from a ground bag and back does not re-fire its notification', () => {
    // Real trace (trimmed - see fixtures README): the same loot-bag entity
    // (objectId 609, a BagType-2 bag holding one Greater Magic Potion)
    // repeatedly leaves and re-enters the client's view range - each
    // `UpdatePacket.drops` (walk out of range) followed by a fresh
    // `newObjects` entry (walk back) for the identical objectId/slot. The
    // item drops only once; the bag is just re-observed. An itemOverride
    // (tier 0) forces `enchantedDrop` to match on every sighting, the same
    // way the reporter's own configured rule matched this item live.
    const envelopes = loadCapture(join(FIXTURES_DIR, 'soak-237-loot-reenter.json.gz'))
    const engine = new AlertEngine()
    engine.setSettings({
      enabled: true,
      volume: 1,
      rules: {
        enchantedDrop: {
          enabled: true,
          banner: true,
          sound: true,
          params: { tier: 4, slotTypeOverrides: {}, itemOverrides: { 'greater magic potion': 0 } }
        }
      }
    })

    replay(engine, envelopes)

    expect(engine.store.getAll()).toHaveLength(1)
  })
})
