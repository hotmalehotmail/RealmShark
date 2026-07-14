import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import type { PacketEnvelope } from '../src/shared/ipc'
import { loadCapture, replay } from './replay'

const FIXTURES_DIR = join(__dirname, 'fixtures/captures')

describe('LootTracker capture replay', () => {
  it('soak #122 (equip/unequip, no real bag drop): produces zero loot entries', () => {
    // Regression for issue #124: the pre-fix LootTracker watched the local
    // player's own inventory and mistook an equip/unequip swap for a drop.
    // This capture is real traffic from that soak - a player re-equipping
    // gear, no loot-bag entity anywhere in the trace (see fixtures README).
    // Today's bag-entity-based tracker must find nothing here.
    const packets = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const tracker = new LootTracker()
    replay(tracker, packets)

    expect(tracker.entriesFor(6)).toEqual([])
    expect(tracker.entriesFor(8)).toEqual([])
  })

  it('soak #122 + a synthesized true drop: produces exactly one loot entry', () => {
    // Same real traffic, with a hand-synthesized bag-entity drop appended -
    // wire shapes lifted from bridge/LootBagTypes.java's documented payload
    // and packets/data/enums/StatType.java's INVENTORY_0_STAT (=8). Proves
    // the zero-entries result above is because this trace has no drop, not
    // because the tracker is broken.
    const base = loadCapture(join(FIXTURES_DIR, 'soak-122-equip-unequip.json.gz'))
    const lastTime = base[base.length - 1].time

    const lootBagTypes: PacketEnvelope = {
      type: 'lootBagTypes',
      direction: 'internal',
      time: lastTime + 1000,
      data: {
        bagTypeTable: { '9064': 6 },
        lootBagIcons: { '6': 1292 },
        lootBagObjectTypes: { '1292': 6 },
        itemNames: { '9064': 'Sword of Acclaim' }
      }
    }
    const bagDrop: PacketEnvelope = {
      type: 'UpdatePacket',
      direction: 'incoming',
      time: lastTime + 2000,
      data: {
        newObjects: [
          {
            objectType: 1292,
            status: {
              objectId: 999001,
              stats: [{ statTypeNum: 8, statValue: 9064 }]
            }
          }
        ],
        drops: []
      }
    }

    const packets = [...base, lootBagTypes, bagDrop]
    const tracker = new LootTracker()
    replay(tracker, packets)

    const entries = tracker.entriesFor(6)
    expect(entries).toHaveLength(1)
    expect(entries[0].objectType).toBe(9064)
    expect(tracker.itemName(9064)).toBe('Sword of Acclaim')
  })

  it('soak #144 (loot panel stayed empty): produces zero loot entries, because lootBagTypes never arrives in this trace', () => {
    // Root cause of #144/#146 (see fixtures README): this capture predates
    // the fix and never contains a {type:"lootBagTypes"} envelope at all, so
    // no UpdatePacket.newObjects entry can ever be classified as a bag -
    // regardless of what real bag entities the trace does or doesn't
    // contain. This asserts today's (fixed) tracker reproduces exactly that
    // failure mode against this specific trace; it does NOT prove a real
    // drop is correctly detected (see the synthesized-variant test above for
    // that) since this capture has no way to support that assertion.
    const packets = loadCapture(join(FIXTURES_DIR, 'soak-144-loot-empty.json.gz'))
    expect(packets.some((p) => p.type === 'lootBagTypes')).toBe(false)

    const tracker = new LootTracker()
    replay(tracker, packets)

    expect(tracker.entriesFor(6)).toEqual([])
    expect(tracker.entriesFor(8)).toEqual([])
  })
})
