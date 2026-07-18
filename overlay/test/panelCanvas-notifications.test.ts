import { describe, expect, it } from 'vitest'
import { mergeWithDefaults } from '../src/renderer/src/panels/panelLayout'
import type { PanelInstance } from '../src/shared/panels'

// Mirrors the pre-issue-#220 defaultLayout() ids exactly, simulating a real
// user's saved panels.json from before the Notifications panel existed.
const PRE_NOTIFICATIONS_SAVED: PanelInstance[] = [
  { id: 'status', type: 'status', anchor: { pos: 'tl', x: 2, y: 2 }, size: 'md', zIndex: 1 },
  { id: 'dps', type: 'dps', anchor: { pos: 'tl', x: 2, y: 30 }, size: 'md', zIndex: 2 },
  { id: 'console', type: 'console', anchor: { pos: 'tl', x: 35, y: 2 }, size: 'md', zIndex: 3 },
  {
    id: 'character',
    type: 'character',
    anchor: { pos: 'tl', x: 35, y: 50 },
    size: 'md',
    zIndex: 4
  },
  { id: 'instance', type: 'instance', anchor: { pos: 'tl', x: 65, y: 2 }, size: 'md', zIndex: 5 },
  {
    id: 'dpsSummary',
    type: 'dpsSummary',
    anchor: { pos: 'tl', x: 65, y: 40 },
    size: 'md',
    zIndex: 6
  },
  { id: 'loot', type: 'loot', anchor: { pos: 'tl', x: 35, y: 75 }, size: 'md', zIndex: 7 }
]

describe('PanelCanvas mergeWithDefaults - notifications panel (issue #220)', () => {
  it('appends the notifications panel for an existing user upgrading from before it existed', () => {
    const merged = mergeWithDefaults(PRE_NOTIFICATIONS_SAVED)
    expect(merged).toHaveLength(PRE_NOTIFICATIONS_SAVED.length + 1)
    // Every pre-existing saved panel is kept untouched (positions/zIndex
    // aren't reset - only the missing default is appended).
    expect(merged.slice(0, PRE_NOTIFICATIONS_SAVED.length)).toEqual(PRE_NOTIFICATIONS_SAVED)
    const notifications = merged.find((p) => p.id === 'notifications')
    expect(notifications).toBeDefined()
    expect(notifications?.type).toBe('notifications')
  })

  it('leaves a layout that already has notifications unchanged', () => {
    const alreadyUpgraded: PanelInstance[] = [
      ...PRE_NOTIFICATIONS_SAVED,
      {
        id: 'notifications',
        type: 'notifications',
        anchor: { pos: 'tl', x: 10, y: 10 },
        size: 'sm',
        zIndex: 9
      }
    ]
    expect(mergeWithDefaults(alreadyUpgraded)).toEqual(alreadyUpgraded)
  })

  it('a fresh install (no saved layout) includes notifications among the defaults', () => {
    expect(mergeWithDefaults(undefined).some((p) => p.id === 'notifications')).toBe(true)
    expect(mergeWithDefaults([]).some((p) => p.id === 'notifications')).toBe(true)
  })
})
