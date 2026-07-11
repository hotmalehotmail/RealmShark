import type { PanelSize } from '../../shared/panels'
import type { DpsSnapshot } from './dps/DpsTracker'
import { CharacterSprite } from './sprites/CharacterSprite'
import { useEntityRegistry } from './sprites/context'
import { Sprite } from './sprites/Sprite'

/** Row character-sprite pixel size per panel size. */
const ROW_SPRITE_SIZE: Record<PanelSize, number> = { sm: 16, md: 20, lg: 24 }
/** Row equipment-slot icon pixel size per panel size. 0 hides the gear row (sm degrades to sprite + name + dps only). */
const ROW_SLOT_SIZE: Record<PanelSize, number> = { sm: 0, md: 12, lg: 14 }

/** Compact number formatting (12.3k / 1.2m) so a dyed sprite + 4 gear icons + name still leave room for the dps figures in a narrow row. */
function formatCompact(n: number): string {
  const abs = Math.abs(n)
  const sign = n < 0 ? '-' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}m`
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}k`
  return `${sign}${Math.round(abs)}`
}

interface DpsListProps {
  snapshot: DpsSnapshot
  maxRows: number
  showHeader: boolean
  size: PanelSize
}

function DpsList({ snapshot, maxRows, showHeader, size }: DpsListProps): React.JSX.Element {
  const entities = useEntityRegistry()
  const spriteSize = ROW_SPRITE_SIZE[size]
  const slotSize = ROW_SLOT_SIZE[size]

  if (snapshot.targetId === null) {
    return <div className="text-xs text-white/40">No target attacked yet</div>
  }

  return (
    <div className="text-sm text-white">
      {showHeader && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-white/50">
          <Sprite objectType={entities.objectType(snapshot.targetId)} size={16} />
          <span className="truncate">Target: {snapshot.targetName}</span>
        </div>
      )}
      {snapshot.rows.length === 0 ? (
        <div className="text-xs text-white/40">No recent damage</div>
      ) : (
        <div className="space-y-1">
          {snapshot.rows.slice(0, maxRows).map((row) => {
            const equipment = entities.equipment(row.objectId) ?? []
            return (
              <div key={row.objectId} className="flex items-center gap-1.5 text-xs">
                <CharacterSprite objectId={row.objectId} size={spriteSize} className="shrink-0" />
                {slotSize > 0 && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {equipment.map((itemType, i) =>
                      itemType > 0 ? (
                        <Sprite key={i} objectType={itemType} size={slotSize} />
                      ) : (
                        <span
                          key={i}
                          className="rounded-sm border border-white/10 bg-white/5"
                          style={{ width: slotSize, height: slotSize, flexShrink: 0 }}
                        />
                      )
                    )}
                  </div>
                )}
                <span className="min-w-0 flex-1 truncate text-white/80">{row.name}</span>
                <span className="shrink-0 font-mono text-white/60">
                  {formatCompact(row.dps)} dps{' '}
                  <span className="text-white/30">({formatCompact(row.damage)})</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default DpsList
