import type { ComponentType } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { dpsPanelHeight } from '../dps/rowLayout'
import type { SizePx } from './anchor'
import CharacterPanel from './CharacterPanel'
import ConsolePanel from './ConsolePanel'
import DpsPanel from './DpsPanel'
import DpsSummaryPanel from './DpsSummaryPanel'
import InstancePanel from './InstancePanel'
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
      md: { width: 260, height: 155 },
      lg: { width: 300, height: 195 }
    },
    component: StatusPanel
  },
  dps: {
    type: 'dps',
    title: 'DPS',
    sizes: {
      sm: { width: 180, height: dpsPanelHeight('sm') },
      md: { width: 260, height: dpsPanelHeight('md') },
      lg: { width: 320, height: dpsPanelHeight('lg') }
    },
    component: DpsPanel
  },
  console: {
    type: 'console',
    title: 'Console',
    sizes: {
      sm: { width: 260, height: 120 },
      md: { width: 380, height: 220 },
      lg: { width: 480, height: 320 }
    },
    component: ConsolePanel
  },
  character: {
    type: 'character',
    title: 'Character',
    sizes: {
      sm: { width: 160, height: 100 },
      md: { width: 220, height: 130 },
      lg: { width: 280, height: 170 }
    },
    component: CharacterPanel
  },
  instance: {
    type: 'instance',
    title: 'Instance',
    sizes: {
      sm: { width: 220, height: 180 },
      md: { width: 300, height: 260 },
      lg: { width: 360, height: 360 }
    },
    component: InstancePanel
  },
  dpsSummary: {
    type: 'dpsSummary',
    title: 'DPS Summary',
    sizes: {
      sm: { width: 240, height: 200 },
      md: { width: 320, height: 300 },
      lg: { width: 400, height: 420 }
    },
    component: DpsSummaryPanel
  }
}
