import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import PanelMount from './PanelMount'
import { installHarness } from './shim'

type PanelSizeParam = 'sm' | 'md' | 'lg'

/**
 * Entry point `main.tsx` dynamically imports when the harness dev flag is
 * set (see that file). Installs the `OverlayApi` shim, then either lets the
 * normal `<App/>` canvas render (default) or - for `?panel=<type>&size=
 * <sm|md|lg>` - mounts just that one panel directly, returning `true` so the
 * caller skips its own render.
 */
export function bootstrapHarness(isConfigWindow: boolean): boolean {
  installHarness()
  if (isConfigWindow) return false

  const params = new URLSearchParams(window.location.search)
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
