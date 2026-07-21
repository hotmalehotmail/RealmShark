import DpsList from '../DpsList'
import { DPS_MAX_ROWS } from '../dps/rowLayout'
import { useDpsTracker } from '../dps/useDpsTracker'
import type { PanelContentProps } from './registry'

/**
 * The numeric DPS readout only — the trend graph used to be embedded here
 * (dropped entirely at `sm`) but now lives in its own placeable/sizable
 * `dpsGraph` panel (issue #259), so this panel no longer owns any of the
 * sparkline's presentation or data tick.
 */
function DpsPanel({ size }: PanelContentProps): React.JSX.Element {
  const snapshot = useDpsTracker()
  return (
    <div className="flex h-full flex-col gap-1">
      <DpsList
        snapshot={snapshot}
        maxRows={DPS_MAX_ROWS[size]}
        showHeader={size !== 'sm'}
        size={size}
      />
    </div>
  )
}

export default DpsPanel
