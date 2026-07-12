import type { PanelSize } from '../../shared/panels'
import type { DpsSnapshot } from './dps/DpsTracker'
import { DPS_ROW_SPRITE_SIZE, DPS_ROW_TEXT_SIZE, rowHeight as dpsRowHeight } from './dps/rowLayout'
import type { PlayerDps } from './dps/types'
import { CharacterSprite } from './sprites/CharacterSprite'
import { useEntityRegistry } from './sprites/context'
import { Sprite } from './sprites/Sprite'
import { EmptyState } from './ui/EmptyState'
import { GearRow } from './ui/GearRow'
import { MeterRow } from './ui/MeterRow'

/** Row equipment-slot icon pixel size per panel size. 0 hides the gear row (sm degrades to sprite + name + dps only). */
const ROW_SLOT_SIZE: Record<PanelSize, number> = { sm: 0, md: 16, lg: 20 }

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
 * Picks which rows to render: always exactly `maxRows` slots, so the list's
 * rendered height stays fixed regardless of how many players are currently
 * in the rolling damage window (a `null` slot renders as a blank placeholder
 * row). The local player's row stays in its natural ranked position like
 * everyone else's when that position is within the visible window; it's only
 * pulled into the last slot (displacing the lowest-ranked other row) when
 * their true rank would otherwise fall outside `maxRows`, so the player can
 * always find themselves without their row jumping around while it's already
 * visible. `rows` is already sorted descending by damage.
 */
function selectVisibleRows(
  rows: PlayerDps[],
  maxRows: number,
  localPlayerId: number | null
): (PlayerDps | null)[] {
  const localIndex =
    localPlayerId === null ? -1 : rows.findIndex((r) => r.objectId === localPlayerId)
  const visible =
    localIndex === -1 || localIndex < maxRows
      ? rows.slice(0, maxRows)
      : [...rows.slice(0, Math.max(0, maxRows - 1)), rows[localIndex]]
  const placeholders: null[] = new Array(Math.max(0, maxRows - visible.length)).fill(null)
  return [...visible, ...placeholders]
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
  const spriteSize = DPS_ROW_SPRITE_SIZE[size]
  const slotSize = ROW_SLOT_SIZE[size]
  // Fixed per-row height (real or placeholder) so the list's total rendered
  // height never changes as players enter/leave the rolling damage window.
  const rowHeight = dpsRowHeight(size)

  if (snapshot.targetId === null) {
    return <EmptyState>No target attacked yet</EmptyState>
  }

  const localPlayerId = entities.localPlayerId()
  const rows = ensureLocalRow(snapshot.rows, localPlayerId, entities.name(localPlayerId))
  const topDamage = rows[0]?.damage ?? 0
  const visibleRows = selectVisibleRows(rows, maxRows, localPlayerId)

  return (
    <div>
      {showHeader && (
        <div className="mb-1 flex items-center gap-1.5 text-xs text-fg-faint">
          <Sprite objectType={entities.objectType(snapshot.targetId)} size={16} />
          <span className="truncate">Target: {snapshot.targetName}</span>
        </div>
      )}
      {rows.length === 0 ? (
        <EmptyState>No recent damage</EmptyState>
      ) : (
        <div className="space-y-1">
          {visibleRows.map((row, i) => {
            // Empty slot: keeps the list at a fixed `maxRows` height instead
            // of collapsing when fewer players are in the rolling damage
            // window (see `selectVisibleRows`).
            if (row === null) {
              return <div key={`empty-${i}`} style={{ height: rowHeight }} />
            }
            const isLocal = row.objectId === localPlayerId
            // True rank within the full (unsliced) ranking - matches the
            // row's position in `visibleRows` except when the local player's
            // row has been pulled into the last slot (see `selectVisibleRows`),
            // so it's only surfaced for that row.
            const rank = rows.indexOf(row) + 1
            const fillPct = topDamage > 0 ? (row.damage / topDamage) * 100 : 0
            return (
              <MeterRow
                key={row.objectId}
                fillPct={fillPct}
                highlight={isLocal}
                height={rowHeight}
                textSize={DPS_ROW_TEXT_SIZE[size]}
              >
                <CharacterSprite objectId={row.objectId} size={spriteSize} className="shrink-0" />
                <GearRow equipment={entities.equipment(row.objectId)} slotSize={slotSize} />
                <span className="min-w-0 flex-1 truncate text-fg-muted">
                  {isLocal && (
                    <span className="mr-1 font-mono text-2xs text-accent/80">#{rank}</span>
                  )}
                  {row.name}
                </span>
                <span className="shrink-0 text-right font-mono tabular-nums">
                  <span className="text-fg">{formatCompact(row.damage)}</span>
                  <span className="ml-1 text-2xs text-fg-faint">{formatCompact(row.dps)} dps</span>
                </span>
              </MeterRow>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default DpsList
