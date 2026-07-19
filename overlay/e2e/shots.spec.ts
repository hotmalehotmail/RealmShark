import { existsSync, unlinkSync } from 'node:fs'
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
 * Cap on the expanded frame height for a `-full` variant (below-the-fold
 * blind spot, issue #178). A handful of pixels of slack over the cap is
 * fine - the point is bounding runaway content (e.g. an unbounded log), not
 * a razor-exact ceiling.
 */
const MAX_FULL_HEIGHT_PX = 2000

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
 * Below-the-fold blind spot (issue #178), factored out so both the panel-
 * content loop and the settings-view loop (issue #221) share the exact same
 * clip-detect-and-re-render logic instead of two copies drifting apart. See
 * the main loop's doc comment below for the full rationale.
 */
async function captureFullVariantIfClipped(
  page: import('@playwright/test').Page,
  frame: import('@playwright/test').Locator,
  fullPath: string
): Promise<void> {
  const content = page.locator('[data-panel-content]')
  const { scrollHeight, clientHeight } = await content.evaluate((el) => ({
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight
  }))
  const clips = scrollHeight - clientHeight > 1

  if (!clips) {
    if (existsSync(fullPath)) unlinkSync(fullPath)
    return
  }

  // Give the frame room to grow past the default 900px viewport before
  // measuring/capturing its natural height, so Playwright never has to
  // stitch or clip the capture itself.
  await page.setViewportSize({ width: 1280, height: MAX_FULL_HEIGHT_PX + 200 })
  await frame.evaluate((el) => {
    ;(el as HTMLElement).style.height = 'auto'
  })
  await content.evaluate((el) => {
    const style = (el as HTMLElement).style
    style.flex = 'none'
    style.height = 'auto'
    style.overflow = 'visible'
  })
  const naturalHeight = await frame.evaluate((el) => el.getBoundingClientRect().height)
  const cappedHeight = Math.min(naturalHeight, MAX_FULL_HEIGHT_PX)
  await frame.evaluate((el, h) => {
    ;(el as HTMLElement).style.height = `${h}px`
  }, cappedHeight)

  // `frame` keeps its own `overflow-hidden`, so if `naturalHeight` exceeded
  // the cap the capped frame still visually clips at MAX_FULL_HEIGHT_PX
  // rather than spilling the screenshot past it.
  await frame.screenshot({ path: fullPath })
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
 *
 * Below-the-fold blind spot (issue #178): a panel's content wrapper
 * (`data-panel-content` in `PanelMount.tsx`) clips at `overflow-auto` when
 * `scrollHeight` exceeds `clientHeight` - the preset shot above is still
 * legitimate evidence (it's exactly what the user sees at that preset size)
 * but is silently incomplete when content clips. When it does, a *second*
 * shot re-renders the same mount with the wrapper expanded to its natural
 * content height (capped at `MAX_FULL_HEIGHT_PX`) and saves it alongside the
 * preset shot as `<type>-<size>-full.png`. The `-full` file's mere existence
 * is the deterministic "this panel hides content at this preset size"
 * signal; a combo that stops clipping has its stale `-full` file deleted so
 * orphans can't linger. The preset screenshot above is always taken first,
 * before any of this mutates the DOM, so it stays byte-for-byte unaffected.
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

      // dpsDetail's per-player breakdown (gear, damage share, avg/peak
      // metrics - PRD §5) only renders inside an expanded enemy row, which
      // live requires a click - so the gallery shot expands the top enemy the
      // same way, or the committed evidence would only ever show collapsed
      // headline rows.
      if (type === 'dpsDetail') {
        const topEnemy = page.locator('[data-enemy-row] button').first()
        if (await topEnemy.isVisible()) await topEnemy.click()
      }

      await frame.screenshot({ path: resolve(SCREENSHOT_DIR, `${type}-${size}.png`) })

      await captureFullVariantIfClipped(
        page,
        frame,
        resolve(SCREENSHOT_DIR, `${type}-${size}-full.png`)
      )
    })
  }
}

/**
 * Per-panel settings views (issue #221, PRD §5 "the per-panel gear"): a
 * second shot per `(panel type, size)` combo whose `PanelSpec.settings` is
 * defined (only `notifications` today), captured via the harness's
 * `&settings=1` mount flag (`PanelMount.tsx`) - the same static
 * single-view render `PanelFrame`'s gear flip produces live, minus the flip
 * animation. Subject to the identical below-the-fold clipping as any other
 * panel content (a `notifications-sm-settings.png` shot is real evidence of
 * how little fits in a 220x150 frame), so it gets the same `-full` variant
 * treatment via `captureFullVariantIfClipped`. Unlike `-full`, though,
 * `-settings.png`'s existence tracks a static registry property
 * (`spec.settings`), not runtime-detected clipping - removing a panel's
 * settings view is a deliberate registry edit that should delete its old
 * `-settings*.png` files in the same change, there's nothing to auto-prune.
 */
for (const [type, spec] of Object.entries(PANEL_REGISTRY)) {
  if (!spec.settings) continue
  for (const size of SIZES) {
    test(`${type} settings @ ${size}`, async ({ page }) => {
      await freezeNondeterminism(page)
      await page.goto(`/?panel=${type}&size=${size}&settings=1&fixture=gallery`)
      await page.addStyleTag({
        content:
          '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }'
      })
      await page.waitForFunction(() => window.__harnessFixtureReady === true, undefined, {
        timeout: FIXTURE_READY_TIMEOUT_MS
      })

      const frame = page.locator('[data-panel-frame]')
      await expect(frame).toBeVisible()
      // The settings view loads via its own async getSettings() call
      // (`AlertSettings.tsx`) - wait for its "Loading settings…" placeholder
      // to clear so the shot never races that resolve.
      await expect(page.getByText('Loading settings…')).toHaveCount(0)

      await frame.screenshot({ path: resolve(SCREENSHOT_DIR, `${type}-${size}-settings.png`) })

      await captureFullVariantIfClipped(
        page,
        frame,
        resolve(SCREENSHOT_DIR, `${type}-${size}-settings-full.png`)
      )
    })
  }
}

/**
 * `AlertToastHost` (issue #219, PRD §4) isn't a `PANEL_REGISTRY` entry - it's
 * an App-level singleton banner stack, not a draggable/resizable panel - so
 * it doesn't fall out of the loop above and gets one dedicated shot instead,
 * via the `?toastGallery=1` harness mount (`AlertToastGalleryMount.tsx`),
 * which seeds a representative 4-alert stack (cap-3 visible + "+1 more"
 * overflow line) directly into a `FiredAlertStore` - no packet fixture
 * needed for the alerts themselves; `&fixture=gallery` is only there so the
 * `ItemSprite` icons render from the synthetic `spritePack.json` fixture
 * instead of the no-pack fallback, same as every other panel shot.
 */
test('alertToastHost gallery', async ({ page }) => {
  await freezeNondeterminism(page)
  await page.goto('/?toastGallery=1&fixture=gallery')
  await page.addStyleTag({
    content:
      '*, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition-duration: 0s !important; transition-delay: 0s !important; }'
  })
  await page.waitForFunction(() => window.__harnessFixtureReady === true, undefined, {
    timeout: FIXTURE_READY_TIMEOUT_MS
  })

  const gallery = page.locator('[data-toast-gallery]')
  await expect(gallery).toBeVisible()
  await expect(gallery.getByText('+1 more')).toBeVisible()

  await gallery.screenshot({ path: resolve(SCREENSHOT_DIR, 'alertToastHost-gallery.png') })
})
