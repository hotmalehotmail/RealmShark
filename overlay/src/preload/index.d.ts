import type { OverlayApi } from './index'

declare global {
  interface Window {
    overlay: OverlayApi
  }
}
