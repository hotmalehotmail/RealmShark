import { describe, expect, it } from 'vitest'
import type { PacketEnvelope } from '../src/shared/ipc'
import { LootTracker } from '../src/renderer/src/loot/LootTracker'
import type { LootBagTypesData } from '../src/renderer/src/loot/types'

function metaEnvelope(data: LootBagTypesData, time = 0): PacketEnvelope {
  return { type: 'lootBagTypes', direction: 'internal', time, data }
}

const META_V1: LootBagTypesData = {
  metaVersion: 'oc10',
  bagTypeTable: { '1001': 6 },
  lootBagIcons: { '6': 2000 },
  lootBagObjectTypes: { '3000': 6 },
  itemNames: { '1001': 'Potion of Life' }
}

/** META_V1 without its version stamp - the shape of a pre-#239 capture's envelope. */
function legacyMeta(): LootBagTypesData {
  const legacy = { ...META_V1 }
  delete legacy.metaVersion
  return legacy
}

/**
 * Issue #239: the bridge used to re-broadcast the (post-#217, ~630 KB)
 * `lootBagTypes` envelope every 2 s forever, and `ingestLootMeta` rebuilt
 * every table on each one - a rhythmic overlay-wide hitch. Delivery is now
 * edge-triggered bridge-side, and these tests pin the renderer half of the
 * contract: a re-delivered identical table (a WS reconnect legitimately
 * redelivers; a future bridge-side re-send regression must stay cheap) is
 * skipped instead of rebuilt.
 */
describe('LootTracker lootBagTypes version guard (issue #239)', () => {
  it('skips a same-metaVersion re-delivery (ingest returns false, tables intact)', () => {
    const tracker = new LootTracker()
    expect(tracker.ingest([metaEnvelope(META_V1)])).toBe(true)
    expect(tracker.ingest([metaEnvelope({ ...META_V1 }, 5000)])).toBe(false)
    expect(tracker.itemName(1001)).toBe('Potion of Life')
  })

  it('applies a changed metaVersion even when table sizes are unchanged', () => {
    const tracker = new LootTracker()
    tracker.ingest([metaEnvelope(META_V1)])
    const changed = tracker.ingest([
      metaEnvelope({
        ...META_V1,
        metaVersion: 'oc11',
        itemNames: { '1001': 'Renamed Potion' }
      })
    ])
    expect(changed).toBe(true)
    expect(tracker.itemName(1001)).toBe('Renamed Potion')
  })

  it('skips an identical version-less re-delivery via the size fingerprint (pre-#239 captures)', () => {
    const legacy = legacyMeta()
    const tracker = new LootTracker()
    expect(tracker.ingest([metaEnvelope(legacy)])).toBe(true)
    expect(tracker.ingest([metaEnvelope({ ...legacy }, 5000)])).toBe(false)
  })

  it('applies a version-less envelope whose table sizes changed', () => {
    const legacy = legacyMeta()
    const tracker = new LootTracker()
    tracker.ingest([metaEnvelope(legacy)])
    const changed = tracker.ingest([
      metaEnvelope({
        ...legacy,
        bagTypeTable: { '1001': 6, '1002': 8 },
        itemNames: { '1001': 'Potion of Life', '1002': 'Sword of Splendor' }
      })
    ])
    expect(changed).toBe(true)
    expect(tracker.itemName(1002)).toBe('Sword of Splendor')
  })

  it('keeps the fingerprint across reset(), matching the tables it describes', () => {
    const tracker = new LootTracker()
    tracker.ingest([metaEnvelope(META_V1)])
    tracker.reset()
    // reset() deliberately keeps the asset-derived tables (see LootTracker),
    // so the same-version re-delivery that follows a detach/reattach must
    // still be a skip - the data it would rebuild is already there.
    expect(tracker.ingest([metaEnvelope({ ...META_V1 }, 9000)])).toBe(false)
    expect(tracker.itemName(1001)).toBe('Potion of Life')
  })
})
