import { describe, expect, it } from 'vitest'
import { PARAMS_EDITORS } from '../src/renderer/src/alerts/paramsEditors'

/**
 * `paramsEditors.ts`'s UI-side registry (issue #221, PRD §3): only
 * `enchantedDrop` has typed params in the v1 catalog (`whiteBag`/`orangeBag`
 * take none), so it's the only kind with a registered editor -
 * `AlertSettings.tsx` renders one only when `PARAMS_EDITORS[kindId]` exists.
 * No React-rendering harness exists in this suite (`environment: 'node'`),
 * so this only asserts the registry's shape, not the editor's rendered
 * markup.
 */
describe('PARAMS_EDITORS registry (issue #221)', () => {
  it('registers an editor for enchantedDrop only', () => {
    expect(Object.keys(PARAMS_EDITORS)).toEqual(['enchantedDrop'])
    expect(typeof PARAMS_EDITORS.enchantedDrop).toBe('function')
  })
})
