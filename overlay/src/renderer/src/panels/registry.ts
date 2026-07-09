import type { ComponentType } from 'react'
import type { PanelSize } from '../../../shared/panels'
import type { SizePx } from './anchor'
import DpsPanel from './DpsPanel'
import StatusPanel from './StatusPanel'

export interface PanelContentProps {
  size: PanelSize
}

export interface PanelSpec {
  type: string
  title: string
  sizes: Record<PanelSize, SizePx>
  component: ComponentType<PanelContentProps>
}

export const PANEL_REGISTRY: Record<string, PanelSpec> = {
  status: {
    type: 'status',
    title: 'RealmShark',
    sizes: {
      sm: { width: 160, height: 50 },
      md: { width: 260, height: 130 },
      lg: { width: 300, height: 170 }
    },
    component: StatusPanel
  },
  dps: {
    type: 'dps',
    title: 'DPS',
    sizes: {
      sm: { width: 180, height: 110 },
      md: { width: 260, height: 200 },
      lg: { width: 320, height: 320 }
    },
    component: DpsPanel
  }
}
