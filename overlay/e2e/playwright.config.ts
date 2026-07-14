import { resolve } from 'path'
import { defineConfig } from '@playwright/test'

const PORT = 5183

/**
 * Drives `npm run shots` (PRD §5.3): starts the harness's plain-vite dev
 * server (`vite.harness.config.ts`) and points every test at it. Chromium
 * only, one pinned browser - see `docs/overlay-harness.md` for why (D7/§5.3:
 * committed shots come from one canonical sandbox environment, not whatever
 * browser happens to be installed locally). `executablePath` points at this
 * repo's sandbox-pinned Chromium (see root `CLAUDE.md`'s "Pre-installed
 * browser" section) instead of Playwright's own version-matched download,
 * which the sandbox's network policy may block (PRD §5.5 risk).
 */
export default defineConfig({
  testDir: __dirname,
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Fixed viewport + deviceScaleFactor: 1 (PRD §5.3) - a shot's pixel
    // dimensions must depend only on the panel's own registry preset size,
    // never on the host display.
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || '/opt/pw-browsers/chromium'
    }
  },
  webServer: {
    command: `npx vite --config vite.harness.config.ts --port ${PORT} --strictPort`,
    cwd: resolve(__dirname, '..'),
    port: PORT,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000
  },
  projects: [{ name: 'chromium' }]
})
