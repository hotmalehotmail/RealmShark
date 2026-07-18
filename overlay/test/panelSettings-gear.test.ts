import { describe, expect, it } from 'vitest'
import { PANEL_REGISTRY } from '../src/renderer/src/panels/registry'

/**
 * The generic per-panel settings gear (issue #221, PRD §5): `PanelFrame`
 * renders a gear button only when `PanelSpec.settings` is defined
 * (`panels/PanelFrame.tsx`'s `{Settings && (...)}` guard) - so which panels
 * show a gear is entirely determined by this registry. Asserted here at the
 * data level (no DOM-rendering test harness exists in this suite - see
 * `overlay/vitest.config.ts`'s `environment: 'node'`), which is the
 * acceptance criterion's "explicitly asserted: every other existing panel
 * shows no gear" made concrete.
 */
describe('PANEL_REGISTRY settings gear (issue #221)', () => {
  it('only the notifications panel declares a settings view', () => {
    const withSettings = Object.entries(PANEL_REGISTRY)
      .filter(([, spec]) => spec.settings != null)
      .map(([type]) => type)
    expect(withSettings).toEqual(['notifications'])
  })

  it('every other panel type has no settings component - PanelFrame renders no gear for them', () => {
    for (const [type, spec] of Object.entries(PANEL_REGISTRY)) {
      if (type === 'notifications') continue
      expect(spec.settings, `${type} should not declare a settings view`).toBeUndefined()
    }
  })
})
