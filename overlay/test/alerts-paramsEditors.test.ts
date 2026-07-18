import { describe, expect, it } from 'vitest'
import { PARAMS_EDITORS } from '../src/renderer/src/alerts/paramsEditors'

/**
 * `paramsEditors.ts`'s UI-side registry (issue #221, PRD §3): `whiteBag`/
 * `orangeBag` take no params, so `enchantedDrop` and `partyChat` (issue #222)
 * are the only kinds with a registered editor - `AlertSettings.tsx` renders
 * one only when `PARAMS_EDITORS[kindId]` exists. No React-rendering harness
 * exists in this suite (`environment: 'node'`), so this only asserts the
 * registry's shape, not the editors' rendered markup.
 */
describe('PARAMS_EDITORS registry (issue #221/#222)', () => {
  it('registers an editor for enchantedDrop and partyChat only', () => {
    expect(Object.keys(PARAMS_EDITORS)).toEqual(['enchantedDrop', 'partyChat'])
    expect(typeof PARAMS_EDITORS.enchantedDrop).toBe('function')
    expect(typeof PARAMS_EDITORS.partyChat).toBe('function')
  })
})
