import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, isDevModeActive } from '../src/shared/settings'

/**
 * The dev-mode unlock/toggle layering (issue #266, docs/dev-mode.md):
 * `devMode` (issue #265) is the machine-local unlock hand-set in
 * settings.json; `devModeToggle` is the new persisted runtime toggle shown
 * in the Settings window's Developer section, only visible/effective while
 * `devMode` is on. `isDevModeActive` is what every gated surface (Console
 * panel, Status panel diagnostics, drag-perf, PanelCanvas's debugOnly
 * render guard) actually reads.
 */
describe('isDevModeActive', () => {
  it('is false when the unlock is absent, regardless of the toggle', () => {
    expect(isDevModeActive({ devMode: false, devModeToggle: true })).toBe(false)
    // "the toggle setting is inert if somehow present in the store" (issue #266 AC).
    expect(isDevModeActive({ devMode: false, devModeToggle: false })).toBe(false)
  })

  it('is true only when both the unlock and the toggle are on', () => {
    expect(isDevModeActive({ devMode: true, devModeToggle: true })).toBe(true)
  })

  it('toggling off hides gated surfaces even with the unlock present', () => {
    expect(isDevModeActive({ devMode: true, devModeToggle: false })).toBe(false)
  })
})

describe('DEFAULT_SETTINGS dev-mode fields', () => {
  it('the unlock defaults off (issue #265 - absent = off)', () => {
    expect(DEFAULT_SETTINGS.devMode).toBe(false)
  })

  it('the toggle defaults on, so a freshly-unlocked maintainer sees every debug surface immediately', () => {
    expect(DEFAULT_SETTINGS.devModeToggle).toBe(true)
  })
})
