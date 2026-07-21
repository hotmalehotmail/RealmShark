import { describe, expect, it } from 'vitest'
import {
  isPanelOpen,
  isPersistablePanel,
  mergeWithDefaults,
  withPanelClosed,
  withPanelOpen
} from '../src/renderer/src/panels/panelLayout'
import { PANEL_REGISTRY } from '../src/renderer/src/panels/registry'
import type { PanelInstance } from '../src/shared/panels'

/**
 * Closeable panels: every panel except `status` gets a title-bar ✕; closing
 * a singleton panel hides it (instance kept + persisted, so position and the
 * closed state survive restarts) while closing the `ephemeral` dpsDetail
 * still removes it outright. The Status panel lists the singletons and
 * toggles them via `usePanelSpawn()`. Asserted at the data level (no
 * DOM-rendering harness in this suite - see `overlay/vitest.config.ts`'s
 * `environment: 'node'`), same as `panelSettings-gear.test.ts`.
 */

function panel(id: string, overrides: Partial<PanelInstance> = {}): PanelInstance {
  return { id, type: id, anchor: { pos: 'tl', x: 10, y: 10 }, size: 'md', zIndex: 1, ...overrides }
}

describe('PANEL_REGISTRY closable/ephemeral flags', () => {
  it('every panel except status is closable', () => {
    for (const [type, spec] of Object.entries(PANEL_REGISTRY)) {
      if (type === 'status') continue
      expect(spec.closable, `${type} should be closable`).toBe(true)
    }
  })

  it('status is not closable - it hosts the toggle list that reopens everything else', () => {
    expect(PANEL_REGISTRY.status.closable).toBeUndefined()
  })

  it('only dpsDetail is ephemeral (close = remove instead of hide)', () => {
    const ephemeral = Object.entries(PANEL_REGISTRY)
      .filter(([, spec]) => spec.ephemeral)
      .map(([type]) => type)
    expect(ephemeral).toEqual(['dpsDetail'])
  })
})

describe('withPanelClosed', () => {
  it('hides a singleton panel in place, keeping its anchor/size/pin', () => {
    const panels = [panel('status'), panel('dps', { pinned: true, zIndex: 3 })]
    const closed = withPanelClosed(panels, 'dps')
    expect(closed).toHaveLength(2)
    const dps = closed.find((p) => p.id === 'dps')
    expect(dps).toMatchObject({ hidden: true, pinned: true, zIndex: 3 })
    expect(dps?.anchor).toEqual(panels[1].anchor)
    expect(isPanelOpen(closed, 'dps')).toBe(false)
  })

  it('removes an ephemeral panel outright', () => {
    const panels = [panel('status'), panel('dpsDetail', { zIndex: 9 })]
    const closed = withPanelClosed(panels, 'dpsDetail')
    expect(closed.some((p) => p.id === 'dpsDetail')).toBe(false)
  })

  it('is a no-op for an id not on the canvas', () => {
    const panels = [panel('status')]
    expect(withPanelClosed(panels, 'loot')).toBe(panels)
  })
})

describe('withPanelOpen', () => {
  it('un-hides a closed panel and raises it to the front', () => {
    const panels = [panel('status', { zIndex: 5 }), panel('dps', { hidden: true, zIndex: 2 })]
    const opened = withPanelOpen(panels, 'dps', 'dps', 'md')
    const dps = opened.find((p) => p.id === 'dps')
    expect(dps).toMatchObject({ hidden: false, zIndex: 6 })
    // The re-opened panel keeps its old anchor - it comes back where it was,
    // not at the programmatic-spawn anchor.
    expect(dps?.anchor).toEqual(panels[1].anchor)
    expect(isPanelOpen(opened, 'dps')).toBe(true)
  })

  it('spawns a missing panel with the given type/size', () => {
    const panels = [panel('status')]
    const opened = withPanelOpen(panels, 'dpsDetail', 'dpsDetail', 'lg')
    expect(opened.find((p) => p.id === 'dpsDetail')).toMatchObject({
      type: 'dpsDetail',
      size: 'lg'
    })
  })

  it('returns the same array reference when the panel is already visible and on top', () => {
    const panels = [panel('status', { zIndex: 1 }), panel('dps', { zIndex: 2 })]
    expect(withPanelOpen(panels, 'dps', 'dps')).toBe(panels)
  })
})

describe('closed-panel persistence across restarts', () => {
  it('a hidden singleton panel is still persistable - the closed state must reach panels.json', () => {
    expect(isPersistablePanel(panel('dps', { hidden: true }))).toBe(true)
    expect(isPersistablePanel(panel('notifications'))).toBe(true)
  })

  it('an ephemeral panel is never persisted, closable or not', () => {
    expect(isPersistablePanel(panel('dpsDetail'))).toBe(false)
  })

  it('mergeWithDefaults keeps a hidden panel hidden instead of resurrecting or duplicating it', () => {
    const saved = mergeWithDefaults(undefined).map((p) =>
      p.id === 'loot' ? { ...p, hidden: true } : p
    )
    const merged = mergeWithDefaults(saved)
    expect(merged.filter((p) => p.id === 'loot')).toHaveLength(1)
    expect(merged.find((p) => p.id === 'loot')?.hidden).toBe(true)
    expect(isPanelOpen(merged, 'loot')).toBe(false)
  })
})
