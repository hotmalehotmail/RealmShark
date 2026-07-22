import { describe, expect, it, vi } from 'vitest'

// updater.ts imports electron's `app`/`net` (only for app.getVersion() and the
// HTTPS fetch, neither exercised by these tests - pickRelease/isAlphaTag are
// pure). Stub `electron` so the module loads under vitest's node env, same
// pattern as test/spritePack.test.ts.
vi.mock('electron', () => ({ app: { getVersion: () => '0.0.0' }, net: {} }))

// Imported after the mock so its top-level `import { app, net } from 'electron'`
// resolves to the stub above.
import { isAlphaTag, pickRelease, type GithubRelease } from '../src/main/updater'
import type { OverlaySettings } from '../src/shared/settings'

function release(tag: string, draft = false): GithubRelease {
  return { tag_name: tag, draft }
}

describe('isAlphaTag', () => {
  it('flags -alpha tags', () => {
    expect(isAlphaTag('v0.9.30-alpha')).toBe(true)
  })

  it('does not flag -beta or unsuffixed tags', () => {
    expect(isAlphaTag('v0.9.29-beta')).toBe(false)
    expect(isAlphaTag('v0.9.28')).toBe(false)
  })

  it('treats legacy overlay-test- tags as non-alpha (they predate channels)', () => {
    expect(isAlphaTag('overlay-test-v0.9.10')).toBe(false)
  })
})

describe('pickRelease channel filtering', () => {
  const CURRENT = [0, 9, 27]
  const releases = [
    release('v0.9.30-alpha'),
    release('v0.9.29-beta'),
    release('v0.9.28'),
    release('v0.9.26') // older than current - never eligible either way
  ]

  it('dev mode off: skips the alpha even though it is numerically newest, offers the newest non-alpha instead', () => {
    const best = pickRelease(releases, CURRENT, false)
    expect(best?.release.tag_name).toBe('v0.9.29-beta')
  })

  it('dev mode on: offers the alpha (soak flow unchanged)', () => {
    const best = pickRelease(releases, CURRENT, true)
    expect(best?.release.tag_name).toBe('v0.9.30-alpha')
  })

  it('dev mode off: beta and unsuffixed releases are unaffected', () => {
    const betaOnly = [release('v0.9.29-beta'), release('v0.9.26')]
    expect(pickRelease(betaOnly, CURRENT, false)?.release.tag_name).toBe('v0.9.29-beta')

    const unsuffixedOnly = [release('v0.9.28'), release('v0.9.26')]
    expect(pickRelease(unsuffixedOnly, CURRENT, false)?.release.tag_name).toBe('v0.9.28')
  })

  it('dev mode off, only an alpha is newer than current: returns null (nothing offered)', () => {
    const alphaOnly = [release('v0.9.30-alpha')]
    expect(pickRelease(alphaOnly, CURRENT, false)).toBeNull()
  })

  it('draft releases are always excluded regardless of channel', () => {
    const withDraft = [release('v0.9.31', true), release('v0.9.28')]
    expect(pickRelease(withDraft, CURRENT, true)?.release.tag_name).toBe('v0.9.28')
  })

  it('legacy overlay-test- tags are treated as non-alpha and offered with dev mode off', () => {
    const legacy = [release('overlay-test-v0.9.31')]
    expect(pickRelease(legacy, CURRENT, false)?.release.tag_name).toBe('overlay-test-v0.9.31')
  })

  it('returns null when nothing beats the current version', () => {
    expect(pickRelease([release('v0.9.27')], CURRENT, true)).toBeNull()
  })

  // Issue #266's Developer-section toggle (`OverlaySettings.devModeToggle`)
  // must never reach the updater - the channel stays governed by the
  // `devMode` unlock alone, so turning debug UI off on the soak PC can't
  // silently drop it off the alpha channel. `pickRelease`/`checkForUpdate`
  // only ever take `settings.devMode` (see `main/index.ts`'s call sites) -
  // asserted here by driving the same boolean a real `OverlaySettings`
  // object would produce for "unlocked, toggle off".
  it('channel is unaffected by the toggle - only the unlock (settings.devMode) matters', () => {
    const unlockedToggleOff: Pick<OverlaySettings, 'devMode' | 'devModeToggle'> = {
      devMode: true,
      devModeToggle: false
    }
    const best = pickRelease(releases, CURRENT, unlockedToggleOff.devMode)
    expect(best?.release.tag_name).toBe('v0.9.30-alpha')
  })
})
