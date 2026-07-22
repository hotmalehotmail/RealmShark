import { describe, expect, it } from 'vitest'
import { CATALOG, partyChat } from '../src/renderer/src/alerts/catalog'
import { dispatchEvent } from '../src/renderer/src/alerts/dispatcher'
import type { AlertKind, ChatEvent, LootDropEvent } from '../src/renderer/src/alerts/types'
import type { NotificationsSettings } from '../src/shared/settings'

function whiteBagEvent(overrides: Partial<LootDropEvent> = {}): LootDropEvent {
  return {
    type: 'loot-drop',
    itemType: 1210,
    itemName: 'Doom Bow',
    bagType: 6,
    slotType: 3,
    enchantCount: 4,
    enchantCode: '',
    bagIcon: null,
    ...overrides
  }
}

const BASE_SETTINGS: NotificationsSettings = { enabled: true, volume: 1, rules: {} }

describe('dispatchEvent (issue #218, PRD §3 "Multi-match semantics")', () => {
  it('returns null when notifications are globally disabled', () => {
    const settings: NotificationsSettings = { ...BASE_SETTINGS, enabled: false }
    expect(dispatchEvent(whiteBagEvent(), CATALOG, settings, 0, new Map())).toBeNull()
  })

  it('returns null when nothing in the catalog matches', () => {
    const event = whiteBagEvent({ bagType: 1, enchantCount: 0 }) // not white/orange, not divine
    expect(dispatchEvent(event, CATALOG, BASE_SETTINGS, 0, new Map())).toBeNull()
  })

  it(
    'worked example (PRD §3): a divine white bag with whiteBag banner-only and enchantedDrop sound-only ' +
      'fires one banner (whiteBag payload), one sound, one history entry tagged with both kinds',
    () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          whiteBag: { enabled: true, banner: true, sound: false },
          enchantedDrop: { enabled: true, banner: false, sound: true }
        }
      }
      const event = whiteBagEvent({ bagType: 6, enchantCount: 4 })

      const result = dispatchEvent(event, CATALOG, settings, 1000, new Map())

      expect(result).not.toBeNull()
      expect(result?.matchedKindIds).toEqual(['whiteBag', 'enchantedDrop'])
      expect(result?.sound).toBe(true)
      // The banner is shown and carries whiteBag's payload (the first - and
      // only - banner-wanting survivor), not enchantedDrop's.
      expect(result?.banner).not.toBeNull()
      expect(result?.banner?.title).toBe('White bag!')
      expect(result?.payload).toBe(result?.banner)
    }
  )

  it('no survivor wants a banner: sound still fires, but banner is null (history still carries a payload)', () => {
    const settings: NotificationsSettings = {
      enabled: true,
      volume: 1,
      rules: { whiteBag: { enabled: true, banner: false, sound: true } }
    }
    const event = whiteBagEvent({ bagType: 6, enchantCount: 0 }) // only whiteBag matches (not divine)

    const result = dispatchEvent(event, CATALOG, settings, 1000, new Map())

    expect(result).not.toBeNull()
    expect(result?.banner).toBeNull()
    expect(result?.sound).toBe(true)
    expect(result?.payload.title).toBe('White bag!')
  })

  it('a matched kind on cooldown is dropped from the survivors', () => {
    const cooldownKind: AlertKind = {
      id: 'cooldownTest',
      title: 'Cooldown Test',
      eventType: 'loot-drop',
      defaults: { enabled: true, banner: true, sound: true, params: {} },
      cooldownMs: 5000,
      match: () => ({ title: 'Test', body: 'Test' })
    }
    const catalog = [cooldownKind]
    const lastFiredAt = new Map<string, number>([['cooldownTest', 1000]])

    // Still within the cooldown window.
    expect(dispatchEvent(whiteBagEvent(), catalog, BASE_SETTINGS, 3000, lastFiredAt)).toBeNull()
    // Past the cooldown window - fires again and refreshes lastFiredAt.
    const result = dispatchEvent(whiteBagEvent(), catalog, BASE_SETTINGS, 6001, lastFiredAt)
    expect(result?.matchedKindIds).toEqual(['cooldownTest'])
    expect(lastFiredAt.get('cooldownTest')).toBe(6001)
  })

  it('a disabled kind (per settings) never matches even if its match() would fire', () => {
    const settings: NotificationsSettings = {
      enabled: true,
      volume: 1,
      rules: { whiteBag: { enabled: false, banner: true, sound: true } }
    }
    const result = dispatchEvent(
      whiteBagEvent({ enchantCount: 0 }),
      CATALOG,
      settings,
      0,
      new Map()
    )
    expect(result).toBeNull()
  })

  describe('per-rule cooldown override (issue #269)', () => {
    function chatEvent(overrides: Partial<ChatEvent> = {}): ChatEvent {
      return {
        type: 'chat',
        sender: 'Bob',
        text: 'need help with boss',
        cleanText: 'need help with boss',
        numStars: 5,
        channel: 'party',
        ...overrides
      }
    }

    it("a rule's resolved params.cooldownMs overrides the catalog's static cooldownMs seed", () => {
      const overrideKind: AlertKind = {
        id: 'overrideTest',
        title: 'Override Test',
        eventType: 'loot-drop',
        defaults: { enabled: true, banner: true, sound: true, params: {} },
        cooldownMs: 60000,
        match: () => ({ title: 'Test', body: 'Test' })
      }
      const catalog = [overrideKind]
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          overrideTest: { enabled: true, banner: true, sound: true, params: { cooldownMs: 100 } }
        }
      }
      const lastFiredAt = new Map<string, number>([['overrideTest', 1000]])

      // Past the short user-set 100ms override (but still well within the
      // catalog's static 60000ms seed) - the override wins, so this fires.
      const result = dispatchEvent(whiteBagEvent(), catalog, settings, 1101, lastFiredAt)
      expect(result?.matchedKindIds).toEqual(['overrideTest'])
    })

    it('two party messages within the default 15000ms window: the second is suppressed', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: { partyChat: { enabled: true, banner: true, sound: true, params: { keywords: [] } } }
      }
      const lastFiredAt = new Map<string, number>()

      expect(dispatchEvent(chatEvent(), [partyChat], settings, 0, lastFiredAt)).not.toBeNull()
      // 10s later - still inside the 15s default window.
      expect(dispatchEvent(chatEvent(), [partyChat], settings, 10000, lastFiredAt)).toBeNull()
      // 15001ms later - past the window, fires again.
      expect(dispatchEvent(chatEvent(), [partyChat], settings, 15001, lastFiredAt)).not.toBeNull()
    })

    it('a user-set partyChat cooldown overrides the 15000ms default', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          partyChat: {
            enabled: true,
            banner: true,
            sound: true,
            params: { keywords: [], cooldownMs: 2000 }
          }
        }
      }
      const lastFiredAt = new Map<string, number>()

      expect(dispatchEvent(chatEvent(), [partyChat], settings, 0, lastFiredAt)).not.toBeNull()
      // 1000ms later - inside the user's shorter 2000ms window, suppressed.
      expect(dispatchEvent(chatEvent(), [partyChat], settings, 1000, lastFiredAt)).toBeNull()
      // 2001ms later - past the user's window, fires again (well within the
      // unused 15000ms catalog default, proving the override - not the seed - governs).
      expect(dispatchEvent(chatEvent(), [partyChat], settings, 2001, lastFiredAt)).not.toBeNull()
    })
  })
})
