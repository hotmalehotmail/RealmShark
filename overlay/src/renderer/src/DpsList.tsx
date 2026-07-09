import type { DpsSnapshot } from './dps/DpsTracker'

function formatNumber(n: number): string {
  return Math.round(n).toLocaleString()
}

interface DpsListProps {
  snapshot: DpsSnapshot
  maxRows: number
  showHeader: boolean
}

function DpsList({ snapshot, maxRows, showHeader }: DpsListProps): React.JSX.Element {
  if (snapshot.targetId === null) {
    return <div className="text-xs text-white/40">No target attacked yet</div>
  }

  return (
    <div className="text-sm text-white">
      {showHeader && (
        <div className="mb-1 truncate text-xs text-white/50">Target: {snapshot.targetName}</div>
      )}
      {snapshot.rows.length === 0 ? (
        <div className="text-xs text-white/40">No recent damage</div>
      ) : (
        <div className="space-y-1">
          {snapshot.rows.slice(0, maxRows).map((row) => (
            <div key={row.objectId} className="flex items-center justify-between text-xs">
              <span className="truncate text-white/80">{row.name}</span>
              <span className="font-mono text-white/60">
                {formatNumber(row.dps)} dps{' '}
                <span className="text-white/30">({formatNumber(row.damage)})</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default DpsList
