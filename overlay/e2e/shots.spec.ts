import { resolve } from 'path'
import { expect, test } from '@playwright/test'
import { PANEL_REGISTRY } from '../src/renderer/src/panels/registry'

const SIZES = ['sm', 'md', 'lg'] as const
const SCREENSHOT_DIR = resolve(__dirname, '../../docs/screenshots/panels')
/** `fixtureSource.ts` flips this once every `gallery.json` envelope is delivered - the deterministic "ready" signal instead of a fixed sleep. */
const FIXTURE_READY_TIMEOUT_MS = 20_000
/** Arbitrary fixed instant `Date.now()` resolves to for every shot - see `freezeNondeterminism` below. */
const FROZEN_NOW_MS = 1_700_000_000_000
/** Arbitrary fixed `performance.memory.usedJSHeapSize` reading for the Status panel - see `freezeNondeterminism`. */
const FROZEN_HEAP_BYTES = 42 * 1024 * 1024

/**
 * Two panels read real, run-to-run-varying browser state that has nothing to
 * do with the fixture data: the Console panel timestamps every line with
 * `Date.now()` at log time (`consoleLog.ts`), and the Status panel reads
 * live heap usage (`performance.memory.usedJSHeapSize`). Left alone, both
 * make `npm run shots` produce a pixel diff on every run even with no code
 * change, violating the "deterministic by construction" contract (PRD §5.3).
 * Pinning them can't be done in production code (`Shipped-behavior delta
 * must be limited to the dev-flag guard in main.tsx` - see the issue's
 * out-of-scope list), so it happens here, test-side, via `addInitScript`
 * before the app's first script runs. `Date.now` is the only override needed
 * (not the `Date` constructor) - every call site that matters
 * (`consoleLog.ts`'s `push`, the trackers' rolling-window logic,
 * `fixtureSource.ts`'s rebase) calls `Date.now()`, never `new Date()` for
 * "now".
 */
async function freezeNondeterminism(page: import('@playwright/test').Page): Promise<void> {
  await page.addInitScript(
    ({ now, heapBytes }) => {
      Date.now = () => now
      Object.defineProperty(performance, 'memory', {
        configurable: true,
        value: { usedJSHeapSize: heapBytes }
      })
    },
    { now: FROZEN_NOW_MS, heapBytes: FROZEN_HEAP_BYTES }
  )
}

/**
 * `npm run shots` (PRD §5.3): mounts every registered panel (`registry.ts` -
 * never hardcoded here) at every preset size against the standard
 * `gallery.json`/`spritePack.json` fixtures, and screenshots each into the
 * stable, overwritten-in-place gallery path `docs/screenshots/panels/
 * <type>-<size>.png` (PRD D7). `gallery.json`'s sprite data comes from a
 * synthetic fixture with no animated entries (no `animTable`/`dyeTable`), so
 * there's nothing JS-driven left to freeze there; the CSS animation/
 * transition reset below is defensive insurance against a future animated
 * Tailwind utility, not load-bearing today.
 */
for (const [type, spec] of Object.entries(PANEL_REGISTRY)) {
  for (const size of SIZES) {
    test(`${type} @ ${size}`, async ({ page }) => {
      await freezeNondeterminism(page)
      await page.goto(`/?panel=${type}&size=${size}&fixture=gallery`)
      await page.addStyleTag({
        content:
          '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }'
      })
      await page.waitForFunction(() => window.__harnessFixtureReady === true, undefined, {
        timeout: FIXTURE_READY_TIMEOUT_MS
      })

      const frame = page.locator('[data-panel-frame]')
      await expect(frame).toBeVisible()
      const { width, height } = spec.sizes[size]
      await expect(frame).toHaveCSS('width', `${width}px`)
      await expect(frame).toHaveCSS('height', `${height}px`)

      await frame.screenshot({ path: resolve(SCREENSHOT_DIR, `${type}-${size}.png`) })
    })
  }
}
