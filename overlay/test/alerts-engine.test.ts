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

/** `CreateSuccessPacket` + `UpdatePacket`/`NAME_STAT` resolving the local player's identity to (id, name) - same two-source pattern `DpsTracker.ts` uses. */
function localIdentityEnvelopes(id: number, name: string): PacketEnvelope[] {
  return [
    { type: 'CreateSuccessPacket', direction: 'SERVER', time: 500, data: { objectId: id } },
    {
      type: 'UpdatePacket',
      direction: 'SERVER',
      time: 600,
      data: {
        newObjects: [
          { status: { objectId: id, stats: [{ statTypeNum: 31, stringStatValue: name }] } }
        ]
      }
    }
  ]
}

/** A `TextPacket` envelope with the given fields, other fields defaulted to plausible values. */
function textPacket(overrides: Record<string, unknown> = {}): PacketEnvelope {
  return {
    type: 'TextPacket',
    direction: 'SERVER',
    time: 1000,
    data: {
      name: 'Bob',
      objectId: -1,
      numStars: 5,
      bubbleTime: 10,
      recipient: '*Party*',
      text: 'need help with boss',
      cleanText: 'need help with boss',
      isSupporter: false,
      starBackground: 0,
      ...overrides
    }
  }
}

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

  it('records the resolved banner/sound channel flags on the stored alert (issue #219)', () => {
    const engine = new AlertEngine()
    engine.setSettings({
      enabled: true,
      volume: 1,
      rules: { whiteBag: { enabled: true, banner: false, sound: true } }
    })

    engine.ingest(whiteBagDropEnvelopes(6000))

    const alerts = engine.store.getAll()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].banner).toBe(false)
    expect(alerts[0].sound).toBe(true)
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

describe('AlertEngine chat detector (issue #222)', () => {
  const PARTY_CHAT_ENABLED: NotificationsSettings = {
    enabled: true,
    volume: 1,
    rules: { partyChat: { enabled: true, banner: true, sound: true, params: { keywords: [] } } }
  }

  it('fires partyChat for a party-channel message from another player', () => {
    const engine = new AlertEngine()
    engine.setSettings(PARTY_CHAT_ENABLED)
    engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

    engine.ingest([textPacket({ name: 'Bob', objectId: -1, recipient: '*Party*' })])

    const alerts = engine.store.getAll()
    expect(alerts).toHaveLength(1)
    expect(alerts[0].matchedKindIds).toEqual(['partyChat'])
  })

  it('ignores a message from the local player, matched by name - not objectId (party senders arrive with objectId -1)', () => {
    const engine = new AlertEngine()
    engine.setSettings(PARTY_CHAT_ENABLED)
    engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

    // A self-sent party message would also arrive with objectId -1 (if it echoes
    // back at all) - only the name distinguishes it from another player's.
    engine.ingest([textPacket({ name: 'Alice', objectId: -1, recipient: '*Party*' })])

    expect(engine.store.getAll()).toHaveLength(0)
  })

  it('does not fire partyChat for a local/world-channel message even when enabled', () => {
    const engine = new AlertEngine()
    engine.setSettings(PARTY_CHAT_ENABLED)
    engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

    engine.ingest([textPacket({ name: 'Carol', objectId: 3, recipient: '', text: 'hey all' })])

    expect(engine.store.getAll()).toHaveLength(0)
  })

  it('partyChat stays silent under its catalog-default (disabled) settings', () => {
    const engine = new AlertEngine()
    engine.setSettings(DEFAULT_SETTINGS)
    engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

    engine.ingest([textPacket({ name: 'Bob', objectId: -1, recipient: '*Party*' })])

    expect(engine.store.getAll()).toHaveLength(0)
  })

  it('reset() (overlay detach) clears the resolved local-player identity', () => {
    const engine = new AlertEngine()
    engine.setSettings(PARTY_CHAT_ENABLED)
    engine.ingest(localIdentityEnvelopes(6000, 'Alice'))
    engine.reset()

    // With identity cleared, "Alice" is no longer recognized as the local
    // player, so her party message now fires instead of being self-ignored.
    engine.ingest([textPacket({ name: 'Alice', objectId: -1, recipient: '*Party*' })])

    expect(engine.store.getAll()).toHaveLength(1)
  })

  describe('title-code stripping on the chat sender (issue #269)', () => {
    it('a title-suffixed sender name is stripped down to the bare username in the banner', () => {
      const engine = new AlertEngine()
      engine.setSettings(PARTY_CHAT_ENABLED)
      engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

      engine.ingest([
        textPacket({ name: 'Bob,a19d,9a10', objectId: -1, recipient: '*Party*', text: 'inc!' })
      ])

      const alerts = engine.store.getAll()
      expect(alerts).toHaveLength(1)
      expect(alerts[0].payload.title).toBe('Party: Bob')
      expect(alerts[0].payload.title).not.toContain(',')
    })

    it('a self-sent party message with a title suffix is still self-ignored', () => {
      const engine = new AlertEngine()
      engine.setSettings(PARTY_CHAT_ENABLED)
      engine.ingest(localIdentityEnvelopes(6000, 'Alice'))

      // The local player's own NAME_STAT-resolved name is bare "Alice", but
      // her own TextPacket.name can still carry a title suffix.
      engine.ingest([textPacket({ name: 'Alice,a19d,9a10', objectId: -1, recipient: '*Party*' })])

      expect(engine.store.getAll()).toHaveLength(0)
    })
  })
})
