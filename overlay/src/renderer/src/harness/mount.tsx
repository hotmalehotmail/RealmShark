import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { AlertToastGalleryMount } from './AlertToastGalleryMount'
import PanelMount from './PanelMount'
import { installHarness } from './shim'

type PanelSizeParam = 'sm' | 'md' | 'lg'

/**
 * Entry point `main.tsx` dynamically imports when the harness dev flag is
 * set (see that file). Installs the `OverlayApi` shim, then either lets the
 * normal `<App/>` canvas render (default) or mounts a single-purpose view
 * directly, returning `true` so the caller skips its own render:
 * - `?panel=<type>&size=<sm|md|lg>` - one registered panel (`PanelMount`).
 * - `?toastGallery=1` - the `AlertToastHost` representative toast stack
 *   (issue #219, not a `PANEL_REGISTRY` entry - see `AlertToastGalleryMount`).
 */
export function bootstrapHarness(isConfigWindow: boolean): boolean {
  installHarness()
  if (isConfigWindow) return false

  const params = new URLSearchParams(window.location.search)

  if (params.has('toastGallery')) {
    createRoot(document.getElementById('root')!).render(
      <StrictMode>
        <AlertToastGalleryMount />
      </StrictMode>
    )
    return true
  }

  const panelType = params.get('panel')
  if (!panelType) return false

  const size: PanelSizeParam = (params.get('size') as PanelSizeParam | null) ?? 'md'
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <PanelMount type={panelType} size={size} />
    </StrictMode>
  )
  return true
}
