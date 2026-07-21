import type { ComponentType } from 'react'
import type { PanelSize } from '../../../shared/panels'
import { NotificationsSettingsView } from '../alerts/AlertSettings'
import { dpsPanelHeight } from '../dps/rowLayout'
import type { SizePx } from './anchor'
import CharacterPanel from './CharacterPanel'
import ConsolePanel from './ConsolePanel'
import DpsDetailPanel from './DpsDetailPanel'
import DpsGraphPanel from './DpsGraphPanel'
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
   * bar, wired to `usePanelSpawn().closePanel`. Set on every panel except
   * `status`: the Status panel hosts the toggle list that turns closed
   * panels back on, so it must never be closeable itself - closing it would
   * strand the user with no way to reopen anything. What closing *does*
   * depends on `ephemeral` below.
   */
  closable?: boolean
  /**
   * A programmatically-spawned, throwaway panel (`dpsDetail`): closing it
   * removes the instance from the canvas outright, and it never persists to
   * panels.json (`panelLayout.ts`'s `isPersistablePanel` - its content lives
   * in a non-persisted selection context). Closing a *non*-ephemeral panel
   * instead just sets `PanelInstance.hidden`, so its position/size survive
   * and the Status panel's toggle list can bring it back.
   */
  ephemeral?: boolean
  /**
   * Optional settings view (issue #221). When set, `PanelFrame` renders a
   * gear button (interactive mode only, next to pin/size) that flips the
   * panel body in place to this component instead of `component`. Omit for
   * an ordinary panel with no configurable settings - `PanelFrame` then
   * renders no gear at all, per panel type.
   */
  settings?: ComponentType<PanelSettingsProps>
  /**
   * Debug surface (issue #265): hidden from the Status panel's toggle list
   * and never rendered on the canvas while `OverlaySettings.devMode` is off,
   * even if an instance is present in the saved/default layout - the
   * instance itself is left alone (not stripped), so it re-appears the
   * moment dev mode is turned on. See `docs/dev-mode.md`.
   */
  debugOnly?: boolean
}

export const PANEL_REGISTRY: Record<string, PanelSpec> = {
  status: {
    type: 'status',
    title: 'RealmShark',
    // md/lg are sized to fit the panel-toggle list (two wrapped rows of
    // chips) on top of the stats + action rows; sm stays a bare header.
    sizes: {
      sm: { width: 160, height: 50 },
      md: { width: 260, height: 248 },
      lg: { width: 300, height: 260 }
    },
    component: StatusPanel
    // Deliberately NOT closable - see the `closable` doc above.
  },
  dps: {
    type: 'dps',
    title: 'DPS',
    sizes: {
      sm: { width: 200, height: dpsPanelHeight('sm') },
      md: { width: 300, height: dpsPanelHeight('md') },
      lg: { width: 380, height: dpsPanelHeight('lg') }
    },
    component: DpsPanel,
    closable: true
  },
  dpsGraph: {
    type: 'dpsGraph',
    title: 'DPS Graph',
    sizes: {
      sm: { width: 200, height: 110 },
      md: { width: 300, height: 160 },
      lg: { width: 420, height: 220 }
    },
    component: DpsGraphPanel,
    closable: true
  },
  console: {
    type: 'console',
    title: 'Console',
    sizes: {
      sm: { width: 260, height: 120 },
      md: { width: 380, height: 220 },
      lg: { width: 480, height: 320 }
    },
    component: ConsolePanel,
    closable: true,
    debugOnly: true
  },
  character: {
    type: 'character',
    title: 'Character',
    sizes: {
      sm: { width: 160, height: 100 },
      md: { width: 220, height: 130 },
      lg: { width: 280, height: 170 }
    },
    component: CharacterPanel,
    closable: true
  },
  instance: {
    type: 'instance',
    title: 'Instance',
    sizes: {
      sm: { width: 220, height: 180 },
      md: { width: 300, height: 260 },
      lg: { width: 360, height: 360 }
    },
    component: InstancePanel,
    closable: true
  },
  dpsSummary: {
    type: 'dpsSummary',
    title: 'DPS Summary',
    sizes: {
      sm: { width: 240, height: 200 },
      md: { width: 320, height: 300 },
      lg: { width: 400, height: 420 }
    },
    component: DpsSummaryPanel,
    closable: true
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
    closable: true,
    ephemeral: true
  },
  loot: {
    type: 'loot',
    title: 'Loot',
    sizes: {
      sm: { width: 200, height: 140 },
      md: { width: 260, height: 220 },
      lg: { width: 340, height: 300 }
    },
    component: LootPanel,
    closable: true
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
    closable: true,
    settings: NotificationsSettingsView
  }
}
