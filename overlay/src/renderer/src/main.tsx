import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import ConfigWindow from './ConfigWindow'
import { installConsoleCapture } from './consoleLog'

installConsoleCapture()

/**
 * The harness (`harness/mount.tsx`) is reached only via this dynamic import,
 * gated on a flag Vite statically inlines - `import.meta.env.VITE_HARNESS` is
 * absent from a production build's env, so the whole branch (and everything
 * `harness/` imports) dead-code-eliminates out of that bundle. See
 * `docs/overlay-harness.md`.
 */
async function bootstrap(): Promise<void> {
  const isConfigWindow = window.location.hash === '#config'

  if (typeof window.overlay === 'undefined' && import.meta.env.VITE_HARNESS) {
    const { bootstrapHarness } = await import('./harness/mount')
    if (bootstrapHarness(isConfigWindow)) return
  }

  createRoot(document.getElementById('root')!).render(
    <StrictMode>{isConfigWindow ? <ConfigWindow /> : <App />}</StrictMode>
  )
}

void bootstrap()
