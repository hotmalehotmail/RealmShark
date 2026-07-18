import { describe, expect, it } from 'vitest'
import { AlertEngine } from '../src/renderer/src/alerts/AlertEngine'
import { CATALOG } from '../src/renderer/src/alerts/catalog'
import type { AlertKind } from '../src/renderer/src/alerts/types'
import type { PacketEnvelope } from '../src/shared/ipc'
import type { NotificationsSettings } from '../src/shared/settings'

/** A minimal `lootBagTypes` + `UpdatePacket` pair logging one white-bag drop (bagType 6, objectType 1001), same wire shapes as `loot-replay.test.ts`. */
function whiteBagDropEnvelopes(objectId: number): PacketEnvelope[] {
  return [
    {
      type: 'lootBagTypes',
      direction: 'SERVER',
      time: 1000,
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
      time: 1500,
      data: {
        newObjects: [
          {
            objectType: 3000,
            status: { objectId, stats: [{ statTypeNum: 8, statValue: 1001 }] }
          }
        ],
        drops: []
      }
    }
  ]
}

const DEFAULT_SETTINGS: NotificationsSettings = { enabled: true, volume: 1, rules: {} }

describe('AlertEngine (issue #218)', () => {
  it('fires whiteBag for a white-bag drop under default (catalog-default) settings', () => {
    const engine = new AlertEngine()
    engine.setSettings(DEFAULT_SETTINGS)

    engine.ingest(whiteBagDropEnvelopes(6000))

    const alerts = engine.store.getAll()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].matchedKindIds).toEqual(['whiteBag'])
  })

  it('picks up settings-changed pushes live, no restart needed', () => {
    const engine = new AlertEngine()
    engine.setSettings({
      enabled: true,
      volume: 1,
      rules: { whiteBag: { enabled: false, banner: true, sound: true } }
    })

    engine.ingest(whiteBagDropEnvelopes(6000))
    expect(engine.store.getAll()).toHaveLength(0)

    // Live update, same engine instance, no reconstruction.
    engine.setSettings(DEFAULT_SETTINGS)
    engine.ingest(whiteBagDropEnvelopes(6001))
    expect(engine.store.getAll()).toHaveLength(1)
  })

  it('MapInfoPacket (instance change) does not clear the fired-alert log', () => {
    const engine = new AlertEngine()
    engine.setSettings(DEFAULT_SETTINGS)
    engine.ingest(whiteBagDropEnvelopes(6000))
    expect(engine.store.getAll()).toHaveLength(1)

    engine.ingest([{ type: 'MapInfoPacket', direction: 'SERVER', time: 2000, data: {} }])

    expect(engine.store.getAll()).toHaveLength(1)
  })

  it('reset() (overlay detach) clears the fired-alert log', () => {
    const engine = new AlertEngine()
    engine.setSettings(DEFAULT_SETTINGS)
    engine.ingest(whiteBagDropEnvelopes(6000))
    expect(engine.store.getAll()).toHaveLength(1)

    engine.reset()

    expect(engine.store.getAll()).toEqual([])
  })

  it('a synthetic catalog entry fires end-to-end (event -> store) with zero dispatcher/store changes', () => {
    const syntheticKind: AlertKind = {
      id: 'syntheticTestKind',
      title: 'Synthetic Test Kind',
      eventType: 'loot-drop',
      defaults: { enabled: true, banner: true, sound: true, params: {} },
      match: (event) => {
        if (event.type !== 'loot-drop' || event.itemName !== 'Potion of Life') return null
        return { title: 'Synthetic fired!', body: 'test' }
      }
    }
    const engine = new AlertEngine({ catalog: [...CATALOG, syntheticKind] })
    engine.setSettings(DEFAULT_SETTINGS)

    engine.ingest(whiteBagDropEnvelopes(6000))

    const alerts = engine.store.getAll()
    expect(alerts).toHaveLength(1)
    // whiteBag also matches (bagType 6), so both kinds are tagged on the same fired alert.
    expect(alerts[0].matchedKindIds).toContain('syntheticTestKind')
    expect(alerts[0].matchedKindIds).toContain('whiteBag')
  })
})
