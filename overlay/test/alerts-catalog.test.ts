import { describe, expect, it } from 'vitest'
import {
  CATALOG,
  enchantedDrop,
  orangeBag,
  resolveRuleSettings,
  whiteBag,
  type EnchantedDropParams
} from '../src/renderer/src/alerts/catalog'
import type { NotificationsSettings } from '../src/shared/settings'
import type { LootDropEvent } from '../src/renderer/src/alerts/types'

function lootDrop(overrides: Partial<LootDropEvent> = {}): LootDropEvent {
  return {
    type: 'loot-drop',
    itemType: 1001,
    itemName: 'Potion of Life',
    bagType: 6,
    slotType: 0,
    enchantCount: 0,
    enchantCode: '',
    bagIcon: null,
    ...overrides
  }
}

const EMPTY_SETTINGS: NotificationsSettings = { enabled: true, volume: 1, rules: {} }

describe('catalog (issue #218)', () => {
  it('catalog order is whiteBag, orangeBag, enchantedDrop - the documented banner priority order', () => {
    expect(CATALOG.map((k) => k.id)).toEqual(['whiteBag', 'orangeBag', 'enchantedDrop'])
  })

  it('whiteBag matches only bagType 6', () => {
    expect(whiteBag.match(lootDrop({ bagType: 6 }), {}, EMPTY_SETTINGS)).not.toBeNull()
    expect(whiteBag.match(lootDrop({ bagType: 8 }), {}, EMPTY_SETTINGS)).toBeNull()
  })

  it('orangeBag matches only bagType 8', () => {
    expect(orangeBag.match(lootDrop({ bagType: 8 }), {}, EMPTY_SETTINGS)).not.toBeNull()
    expect(orangeBag.match(lootDrop({ bagType: 6 }), {}, EMPTY_SETTINGS)).toBeNull()
  })

  describe('loot-bag spoiler avoidance (soak #234)', () => {
    it('whiteBag/orangeBag payloads do not reveal the item name or its icon by default', () => {
      const payload = whiteBag.match(
        lootDrop({
          bagType: 6,
          itemName: 'Doom Bow',
          enchantCount: 3,
          itemType: 1210,
          bagIcon: 555
        }),
        {},
        EMPTY_SETTINGS
      )
      expect(payload?.title).toBe('White bag!')
      expect(payload?.body).not.toContain('Doom Bow')
      // Shows the bag's own icon, not the item's.
      expect(payload?.icon).toBe(555)
    })

    it('falls back to no icon when the bag icon has not resolved yet', () => {
      const payload = whiteBag.match(
        lootDrop({ bagType: 6, itemType: 1210, bagIcon: null }),
        {},
        EMPTY_SETTINGS
      )
      expect(payload?.icon).toBeUndefined()
    })

    it('reveals the item when the drop also fires enchantedDrop via a specific item-name override', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          enchantedDrop: {
            enabled: true,
            banner: true,
            sound: true,
            params: { tier: 4, slotTypeOverrides: {}, itemOverrides: { 'doom bow': 1 } }
          }
        }
      }
      const payload = whiteBag.match(
        lootDrop({ bagType: 6, itemName: 'Doom Bow', itemType: 1210, enchantCount: 1 }),
        {},
        settings
      )
      expect(payload?.body).toBe('Doom Bow (1 enchant)')
      expect(payload?.icon).toBe(1210)
    })

    it('reveals the item when the drop also fires enchantedDrop via a SlotType-category override', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          enchantedDrop: {
            enabled: true,
            banner: true,
            sound: true,
            params: { tier: 4, slotTypeOverrides: { 3: 1 }, itemOverrides: {} }
          }
        }
      }
      const payload = orangeBag.match(
        lootDrop({ bagType: 8, slotType: 3, itemType: 1210, enchantCount: 1 }),
        {},
        settings
      )
      expect(payload?.body).toContain('enchant')
      expect(payload?.icon).toBe(1210)
    })

    it('does NOT reveal the item when only the global enchantedDrop tier matched (no override)', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          enchantedDrop: {
            enabled: true,
            banner: true,
            sound: true,
            params: { tier: 1, slotTypeOverrides: {}, itemOverrides: {} }
          }
        }
      }
      const payload = whiteBag.match(
        lootDrop({ bagType: 6, itemName: 'Doom Bow', enchantCount: 4 }),
        {},
        settings
      )
      expect(payload?.body).not.toContain('Doom Bow')
    })

    it('does NOT reveal the item when enchantedDrop is disabled, even with a matching override configured', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: {
          enchantedDrop: {
            enabled: false,
            banner: true,
            sound: true,
            params: { tier: 4, slotTypeOverrides: {}, itemOverrides: { 'doom bow': 1 } }
          }
        }
      }
      const payload = whiteBag.match(
        lootDrop({ bagType: 6, itemName: 'Doom Bow', enchantCount: 1 }),
        {},
        settings
      )
      expect(payload?.body).not.toContain('Doom Bow')
    })
  })

  describe('enchantedDrop threshold resolution', () => {
    const defaultParams: EnchantedDropParams = { tier: 4, slotTypeOverrides: {}, itemOverrides: {} }

    it('fires at the default global tier (divine, 4) regardless of bag color', () => {
      expect(
        enchantedDrop.match(lootDrop({ bagType: 2, enchantCount: 4 }), defaultParams)
      ).not.toBeNull()
      expect(
        enchantedDrop.match(lootDrop({ bagType: 2, enchantCount: 3 }), defaultParams)
      ).toBeNull()
    })

    it('a slotType override lowers the threshold for that category', () => {
      const params: EnchantedDropParams = {
        tier: 4,
        slotTypeOverrides: { 8: 1 },
        itemOverrides: {}
      }
      expect(enchantedDrop.match(lootDrop({ slotType: 8, enchantCount: 1 }), params)).not.toBeNull()
      // A different slotType is unaffected and still needs the global tier.
      expect(enchantedDrop.match(lootDrop({ slotType: 3, enchantCount: 1 }), params)).toBeNull()
    })

    it('an item-name override is most specific and wins over a slotType override', () => {
      const params: EnchantedDropParams = {
        tier: 4,
        slotTypeOverrides: { 8: 3 },
        itemOverrides: { 'doom bow': 1 }
      }
      expect(
        enchantedDrop.match(
          lootDrop({ slotType: 8, itemName: 'Doom Bow', enchantCount: 1 }),
          params
        )
      ).not.toBeNull()
    })

    it('item-name matching is case-insensitive exact', () => {
      const params: EnchantedDropParams = {
        tier: 4,
        slotTypeOverrides: {},
        itemOverrides: { 'doom bow': 1 }
      }
      expect(
        enchantedDrop.match(lootDrop({ itemName: 'DOOM BOW', enchantCount: 1 }), params)
      ).not.toBeNull()
      expect(
        enchantedDrop.match(lootDrop({ itemName: 'Doom Bow Shiny', enchantCount: 1 }), params)
      ).toBeNull()
    })
  })

  describe('resolveRuleSettings', () => {
    it('falls back to the catalog default when no rules entry exists', () => {
      const resolved = resolveRuleSettings(whiteBag, EMPTY_SETTINGS)
      expect(resolved).toEqual({ enabled: true, banner: true, sound: true, params: {} })
    })

    it('merges a partial rules entry field-by-field onto the catalog default', () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: { whiteBag: { enabled: true, banner: false, sound: true } }
      }
      expect(resolveRuleSettings(whiteBag, settings)).toEqual({
        enabled: true,
        banner: false,
        sound: true,
        params: {}
      })
    })

    it("merges partial enchantedDrop params onto the catalog's default params", () => {
      const settings: NotificationsSettings = {
        enabled: true,
        volume: 1,
        rules: { enchantedDrop: { enabled: true, banner: true, sound: true, params: { tier: 2 } } }
      }
      const resolved = resolveRuleSettings(enchantedDrop, settings)
      expect(resolved.params).toEqual({ tier: 2, slotTypeOverrides: {}, itemOverrides: {} })
    })
  })
})
