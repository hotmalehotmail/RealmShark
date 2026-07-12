import type { PanelSize } from '../../shared/panels'
import type { DpsSnapshot } from './dps/DpsTracker'
import type { PlayerDps } from './dps/types'
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

/**
 * Picks which rows to render: the top `maxRows` by cumulative damage, but
 * with the local player's row always present (pinned in the last slot,
 * displacing the lowest-ranked visible row) even when their true rank falls
 * below the cut. `rows` is already sorted descending by damage.
 */
function selectVisibleRows(
  rows: PlayerDps[],
  maxRows: number,
  localPlayerId: number | null
): PlayerDps[] {
  const localIndex =
    localPlayerId === null ? -1 : rows.findIndex((r) => r.objectId === localPlayerId)
  if (localIndex === -1 || localIndex < maxRows) {
    return rows.slice(0, maxRows)
  }
  return [...rows.slice(0, Math.max(0, maxRows - 1)), rows[localIndex]]
}

/**
 * The bridge/local-estimate rows only ever contain attackers who've actually
 * hit the focused target, so the local player is simply absent (not a
 * zero-damage row) whenever they haven't damaged it yet - e.g. right after
 * focus locks onto a boss teammates are already fighting. Synthesizes a
 * 0-damage row for them in that case so they're always pinned and visible
 * (see `selectVisibleRows`), same as everyone else who's engaged the target.
 * `rows` stays sorted descending since the synthetic row's damage is minimal.
 */
function ensureLocalRow(
  rows: PlayerDps[],
  localPlayerId: number | null,
  localName: string | null
): PlayerDps[] {
  if (localPlayerId === null || rows.some((r) => r.objectId === localPlayerId)) {
    return rows
  }
  return [
    ...rows,
    { objectId: localPlayerId, name: localName ?? `#${localPlayerId}`, damage: 0, dps: 0 }
  ]
}

function DpsList({ snapshot, maxRows, showHeader, size }: DpsListProps): React.JSX.Element {
  const entities = useEntityRegistry()
  const spriteSize = ROW_SPRITE_SIZE[size]
  const slotSize = ROW_SLOT_SIZE[size]

  if (snapshot.targetId === null) {
    return <div className="text-xs text-white/40">No target attacked yet</div>
  }

  const localPlayerId = entities.localPlayerId()
  const rows = ensureLocalRow(snapshot.rows, localPlayerId, entities.name(localPlayerId))
  const topDamage = rows[0]?.damage ?? 0
  const visibleRows = selectVisibleRows(rows, maxRows, localPlayerId)

  return (
    <div className="text-sm text-white">
      {showHeader && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-white/50">
          <Sprite objectType={entities.objectType(snapshot.targetId)} size={16} />
          <span className="truncate">Target: {snapshot.targetName}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <div className="text-xs text-white/40">No recent damage</div>
      ) : (
        <div className="space-y-1">
          {visibleRows.map((row) => {
            const equipment = entities.equipment(row.objectId) ?? []
            const isLocal = row.objectId === localPlayerId
            // True rank within the full (unsliced) ranking, not the position
            // in this row's visible list - only meaningful to surface when
            // it's the local player's row (a pinned self-row may sit well
            // past its numeric position in `visibleRows`).
            const rank = rows.indexOf(row) + 1
            const fillPct = topDamage > 0 ? Math.min(100, (row.damage / topDamage) * 100) : 0
            return (
              <div
                key={row.objectId}
                className={`relative flex items-center gap-1.5 overflow-hidden rounded-sm text-xs ${
                  isLocal ? 'ring-1 ring-inset ring-sky-400/70' : ''
                }`}
              >
                <div
                  className={`absolute inset-y-0 left-0 ${isLocal ? 'bg-sky-500/25' : 'bg-white/10'}`}
                  style={{ width: `${fillPct}%` }}
                />
                <div className="relative z-10 flex w-full min-w-0 items-center gap-1.5">
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
                  <span className="min-w-0 flex-1 truncate text-white/80">
                    {isLocal && (
                      <span className="mr-1 font-mono text-[10px] text-sky-300/80">#{rank}</span>
                    )}
                    {row.name}
                  </span>
                  <span className="shrink-0 text-right font-mono">
                    <span className="text-white/90">{formatCompact(row.damage)}</span>
                    <span className="ml-1 text-[10px] text-white/40">
                      {formatCompact(row.dps)} dps
                    </span>
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default DpsList
