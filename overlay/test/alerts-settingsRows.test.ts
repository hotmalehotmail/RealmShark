import { describe, expect, it } from 'vitest'
import { buildRuleRows } from '../src/renderer/src/alerts/settingsRows'
import { CATALOG } from '../src/renderer/src/alerts/catalog'
import type { AlertKind } from '../src/renderer/src/alerts/types'
import type { NotificationsSettings } from '../src/shared/settings'

const EMPTY_SETTINGS: NotificationsSettings = { enabled: true, volume: 1, rules: {} }

describe('buildRuleRows (issue #221)', () => {
  it('produces one row per built-in catalog entry, in catalog order', () => {
    const rows = buildRuleRows(CATALOG, EMPTY_SETTINGS)
    expect(rows.map((r) => r.kindId)).toEqual([
      'whiteBag',
      'orangeBag',
      'enchantedDrop',
      'partyChat'
    ])
  })

  it("each row's settings are the catalog default when no user override exists", () => {
    const rows = buildRuleRows(CATALOG, EMPTY_SETTINGS)
    const whiteBagRow = rows.find((r) => r.kindId === 'whiteBag')
    expect(whiteBagRow?.settings).toEqual({ enabled: true, banner: true, sound: true, params: {} })
  })

  it('a row reflects a user override', () => {
    const settings: NotificationsSettings = {
      enabled: true,
      volume: 1,
      rules: { whiteBag: { enabled: true, banner: false, sound: true } }
    }
    const rows = buildRuleRows(CATALOG, settings)
    expect(rows.find((r) => r.kindId === 'whiteBag')?.settings.banner).toBe(false)
  })

  it('a synthetic catalog entry appears as a row with no settings-UI code changes (extensibility, PRD §1/§3)', () => {
    const syntheticKind: AlertKind = {
      id: 'syntheticTestKind',
      title: 'Synthetic Test Kind',
      eventType: 'loot-drop',
      defaults: { enabled: true, banner: true, sound: false, params: { foo: 'bar' } },
      match: () => null
    }
    const rows = buildRuleRows([...CATALOG, syntheticKind], EMPTY_SETTINGS)
    const row = rows.find((r) => r.kindId === 'syntheticTestKind')
    expect(row).toBeDefined()
    expect(row?.title).toBe('Synthetic Test Kind')
    expect(row?.settings).toEqual({
      enabled: true,
      banner: true,
      sound: false,
      params: { foo: 'bar' }
    })
  })
})
