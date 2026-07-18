import type { ComponentType } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { NotificationsSettingsView } from '../alerts/AlertSettings'
import { dpsPanelHeight } from '../dps/rowLayout'
import type { SizePx } from './anchor'
import CharacterPanel from './CharacterPanel'
import ConsolePanel from './ConsolePanel'
import DpsDetailPanel from './DpsDetailPanel'
import DpsPanel from './DpsPanel'
import DpsSummaryPanel from './DpsSummaryPanel'
import InstancePanel from './InstancePanel'
import LootPanel from './LootPanel'
import NotificationsPanel from './NotificationsPanel'
import StatusPanel from './StatusPanel'

export interface PanelContentProps {
  size: PanelSize
}

/**
 * Props for a panel's settings view (issue #221, PRD §5 "the per-panel
 * gear"). Unlike `PanelContentProps`, no `size` - a settings view always
 * renders at whatever size the panel currently is, same as `component`, but
 * doesn't need to scale its own content by preset the way a content body
 * does (a settings form is read top-to-bottom, not glanced at).
 */
export interface PanelSettingsProps {
  /** Flips the panel body back to `component` - wired to both the gear button (toggle) and, optionally, a "Done" control the settings view renders itself. */
  onDone: () => void
}

export interface PanelSpec {
  type: string
  title: string
  sizes: Record<PanelSize, SizePx>
  component: ComponentType<PanelContentProps>
  /**
   * Whether `PanelFrame` renders a close (✕) control in this panel's title
   * bar, wired to `usePanelSpawn().closePanel` - for a panel that's
   * programmatically opened rather than always present in the default
   * layout (e.g. `dpsDetail`). Omit/false for every ordinary always-on panel.
   */
  closable?: boolean
  /**
   * Optional settings view (issue #221). When set, `PanelFrame` renders a
   * gear button (interactive mode only, next to pin/size) that flips the
   * panel body in place to this component instead of `component`. Omit for
   * an ordinary panel with no configurable settings - `PanelFrame` then
   * renders no gear at all, per panel type.
   */
  settings?: ComponentType<PanelSettingsProps>
}

export const PANEL_REGISTRY: Record<string, PanelSpec> = {
  status: {
    type: 'status',
    title: 'RealmShark',
    sizes: {
      sm: { width: 160, height: 50 },
      md: { width: 260, height: 184 },
      lg: { width: 300, height: 195 }
    },
    component: StatusPanel
  },
  dps: {
    type: 'dps',
    title: 'DPS',
    sizes: {
      sm: { width: 200, height: dpsPanelHeight('sm') },
      md: { width: 300, height: dpsPanelHeight('md') },
      lg: { width: 380, height: dpsPanelHeight('lg') }
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
  },
  dpsDetail: {
    type: 'dpsDetail',
    title: 'DPS Detail',
    // Deliberately larger than dpsSummary at every preset - the whole point
    // of #194 is giving the per-enemy/per-player breakdown room to breathe
    // instead of being cramped inside the small summary panel.
    sizes: {
      sm: { width: 320, height: 320 },
      md: { width: 460, height: 460 },
      lg: { width: 620, height: 560 }
    },
    component: DpsDetailPanel,
    closable: true
  },
  loot: {
    type: 'loot',
    title: 'Loot',
    sizes: {
      sm: { width: 200, height: 140 },
      md: { width: 260, height: 220 },
      lg: { width: 340, height: 300 }
    },
    component: LootPanel
  },
  notifications: {
    type: 'notifications',
    title: 'Notifications',
    sizes: {
      sm: { width: 220, height: 150 },
      md: { width: 300, height: 240 },
      lg: { width: 380, height: 320 }
    },
    component: NotificationsPanel,
    settings: NotificationsSettingsView
  }
}
