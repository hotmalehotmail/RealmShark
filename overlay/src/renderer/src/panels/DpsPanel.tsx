import DpsList from '../DpsList'
import { DPS_MAX_ROWS } from '../dps/rowLayout'
import { useDpsTracker } from '../dps/useDpsTracker'
import type { PanelContentProps } from './registry'

function DpsPanel({ size }: PanelContentProps): React.JSX.Element {
  const snapshot = useDpsTracker()
  return (
    <DpsList
      snapshot={snapshot}
      maxRows={DPS_MAX_ROWS[size]}
      showHeader={size !== 'sm'}
      size={size}
    />
  )
}

export default DpsPanel
