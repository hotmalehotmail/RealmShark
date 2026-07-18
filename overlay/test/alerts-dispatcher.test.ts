import { describe, expect, it } from 'vitest'
import { CATALOG } from '../src/renderer/src/alerts/catalog'
import { dispatchEvent } from '../src/renderer/src/alerts/dispatcher'
import type { AlertKind, LootDropEvent } from '../src/renderer/src/alerts/types'
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
})
