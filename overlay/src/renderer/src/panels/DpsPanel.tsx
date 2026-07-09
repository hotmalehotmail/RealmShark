import type { PanelSize } from '../../../shared/panels'
import DpsList from '../DpsList'
import { useDpsTracker } from '../dps/useDpsTracker'
import type { PanelContentProps } from './registry'

const MAX_ROWS: Record<PanelSize, number> = { sm: 3, md: 6, lg: 12 }

function DpsPanel({ size }: PanelContentProps): React.JSX.Element {
  const snapshot = useDpsTracker()
  return <DpsList snapshot={snapshot} maxRows={MAX_ROWS[size]} showHeader={size !== 'sm'} />
}

export default DpsPanel
