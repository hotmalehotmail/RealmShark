import { resolve } from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const CSP_META =
  "content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:\""
const HARNESS_CSP_META =
  "content=\"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:47474 data:\""

/**
 * The shared `index.html`'s CSP meta tag has no `connect-src`, so it falls
 * back to `default-src 'self'` - fine for the packaged app (the bridge
 * WebSocket client lives in the Electron *main* process, never subject to a
 * page CSP), but it would block two things only the harness needs: the
 * page-side `wsSource.ts` reaching `ws://127.0.0.1:47474`, and
 * `SpriteProvider.tsx`'s `fetch()` of a sprite atlas `data:` URL (`fetch()`
 * is governed by `connect-src`, not `img-src`, even for a `data:` target).
 * Loosened here, at harness-serve time only, via `transformIndexHtml` -
 * `index.html` itself stays untouched, so the production (electron-vite)
 * build's CSP is byte-identical to before.
 */
function harnessCsp(): Plugin {
  return {
    name: 'harness-csp',
    transformIndexHtml(html) {
      return html.replace(CSP_META, HARNESS_CSP_META)
    }
  }
}

/**
 * Plain-vite counterpart to `electron.vite.config.ts`'s `renderer` block, for
 * running the renderer as an ordinary browser page with no Electron process
 * behind it (the harness - PRD `docs/prd-agent-observability.md` §5, see
 * `docs/overlay-harness.md`). Reuses the same root/`index.html`/`main.tsx`
 * and the same `@renderer` alias/plugins as the real app; `electron-vite`'s
 * own `npm run dev`/`npm run build` (and their config file) are untouched by
 * this file's existence.
 *
 * `publicDir` points at the fixtures directory so `fixtureSource.ts` can
 * `fetch('/gallery.json.gz')`/`fetch('/spritePack.json')` straight off disk
 * with no custom server code. `define` inlines `import.meta.env.VITE_HARNESS`
 * as a compile-time constant, the flag `main.tsx` dynamically imports the
 * harness behind - true only for bundles built from *this* config, so it
 * never needs a separate `--mode`/`.env` file to remember.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  publicDir: resolve(__dirname, 'test/fixtures'),
  resolve: {
    alias: {
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  define: {
    'import.meta.env.VITE_HARNESS': JSON.stringify('true')
  },
  plugins: [react(), tailwindcss(), harnessCsp()],
  server: {
    port: 5183,
    strictPort: true
  },
  preview: {
    port: 5183,
    strictPort: true
  }
})
