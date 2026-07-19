import DpsList from '../DpsList'
import DpsSparkline from '../DpsSparkline'
import { DPS_MAX_ROWS } from '../dps/rowLayout'
import { useDpsTracker } from '../dps/useDpsTracker'
import type { PanelContentProps } from './registry'

function DpsPanel({ size }: PanelContentProps): React.JSX.Element {
  const snapshot = useDpsTracker()
  return (
    <div className="flex h-full flex-col gap-1">
      {/* The trend line owns its own data tick (useDpsGraph), so its 4 Hz
          updates re-render the sparkline alone, never the row list below. */}
      {size !== 'sm' && <DpsSparkline />}
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
